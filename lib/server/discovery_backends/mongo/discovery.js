MongoClient = Npm.require("mongodb").MongoClient;
MongoDiscovery = {};
Cluster.registerDiscoveryBackend("mongodb", MongoDiscovery);

MongoDiscovery.connect = function connect(mongoUrl, clusterInstance, options) {
  if(this._conn) {
    throw new Error("MongoDiscovery is already connected!");
  }

  options = options || {};
  this._selfWeight = options.selfWeight;
  this._clusterInstance = clusterInstance;
  this._dataFetchInterval = options.dataFetchInterval || 5 * 1000;

  var collName = options.collName || "clusterEndpoints";
  // connect and watch for balancers and endpoints
  this._connUrl = mongoUrl;
  this._conn = Meteor.wrapAsync(MongoClient.connect)(mongoUrl, {
    server: {poolSize: 1},
    replSet: {poolSize: 1}
  });
  this._endpointsColl = this._createCollection(collName);

  // maintains a list of most recent endoints in the cluster
  this._currentEndpoints = new MongoDiscoveryStore();
  // maintains a list of most recent balancers in the cluster
  this._currentBalancers = new MongoDiscoveryStore();

  this._watchHander = this._startWatching();
  this._changeCallbacks = (options.changeCallbacks)?[options.changeCallbacks]: this._changeCallbacks || [];
  if ( this._changeCallbacks && options.changeCallback) {
    this._changeCallbacks.push(option.changeCallback);
  }
};

MongoDiscovery._createCollection = function(collName) {
  var coll = this._conn.collection(collName);

  coll.update = Meteor.wrapAsync(coll.update, coll);
  coll.insert = Meteor.wrapAsync(coll.insert, coll);
  coll.findOne = Meteor.wrapAsync(coll.findOne, coll);

  var originalFind = coll.find;
  coll.find = function() {
    var cursor = originalFind.apply(coll, arguments);
    cursor.fetch = function() {
      cursor.rewind();
      return Meteor.wrapAsync(cursor.toArray, cursor)();
    };
    return cursor;
  };

  return coll;
};

MongoDiscovery.disconnect = function disconnect() {
  var self = this;
  this._watchHander.stop();
  this._watchHander = null;

  this._conn.close();
  this._conn = null;

  if(this._pingHandler) {
    Meteor.clearTimeout(this._pingHandler);
  }

  [
    '_connUrl', '_conn', '_endpointsColl', '_currentEndpoints',
    '_currentBalancers', '_watchHander', '_serviceName', '_balancer',
    '_endpoint', '_endpointHash', '_pingHandler', '_pingInterval'
  ].forEach(function(field) {
    self[field] = null;
  });
};

MongoDiscovery.register = function register(serviceName, options) {
  if(this._pingHandler) {
    throw new Error("this endpoint is already registered!");
  }

  options = options || {};
  this._pingInterval = options.pingInterval || 5 * 1000;

  var balancer = options.balancer;
  var endpoint = options.endpoint || balancer;

  if(!endpoint) {
    console.warn("cluster: no endpoint url. cannot register with the cluster");
    return;
  }

  this._serviceName = serviceName;
  this._balancer = balancer;
  this._endpoint = endpoint;
  this._endpointHash = this._hash(endpoint);

  // pinging logic
  this._ping({sendAllInfo: true});
  this._pingHandler =
    Meteor.setInterval(this._ping.bind(this), this._pingInterval);
};

MongoDiscovery.pickEndpoint = function pickEndpoint(serviceName) {
  // check heathly when picking
  var service = this._getEndpoint(serviceName);
  if(service) {
    return service.endpoint;
  }
};

MongoDiscovery.pickEndpointHash = function pickEndpointHash(serviceName) {
  var service = this._getEndpoint(serviceName);
  if(service) {
    return service.endpointHash;
  }
};

MongoDiscovery._getEndpoint = function(serviceName) {
  if(this._selfWeight >= 0) {
    var endpointHash = this._hash(this._clusterInstance._endpoint);
    var service = this._currentEndpoints.
      getRandomWeighted(serviceName, endpointHash, this._selfWeight);
    return service;
  } else {
    var service = this._currentEndpoints.getRandom(serviceName);
    return service;
  }
};

MongoDiscovery.hashToEndpoint = function hashToEndpoint(hash) {
  var service = this._currentEndpoints.byEndpointHash(hash);
  if(service) {
    return service.endpoint;
  }
};

MongoDiscovery.endpointToHash = function endpointToHash(endpoint) {
  return this._hash(endpoint);
}

// balancer's serviceName is optional
// It doesn't need to be a service
MongoDiscovery.pickBalancer = function pickBalancer(endpointHash) {
  if(endpointHash) {
    var endpointService = this._currentEndpoints.byEndpointHash(endpointHash);
    if(endpointService && endpointService.balancer) {
      return endpointService.balancer;
    }
  }

  var balancerService = this._currentBalancers.getRandom();
  if(balancerService) {
    return balancerService.balancer;
  }

  return null;
};

MongoDiscovery.hasBalancer = function(balancer) {
  return !!this._currentBalancers.byBalancer(balancer);
};

MongoDiscovery._hash = function _hash(endpoint) {
  var crypto = Npm.require('crypto');
  var algo = crypto.createHash('sha1');
  algo.update(endpoint);
  return algo.digest('hex');
};

MongoDiscovery._ping = function _ping(options) {
  options = options || {};
  var sendAllInfo = options.sendAllInfo || false;

  var selector = {
    serviceName: this._serviceName,
    endpoint: this._endpoint,
  };

  var payload = {
    timestamp: new Date(),
    pingInterval: this._pingInterval
  };

  if(sendAllInfo) {
    payload.endpointHash = this._endpointHash;
    payload.balancer = this._balancer;
  }

  this._endpointsColl.update(selector, {$set: payload}, {upsert: true});
};

MongoDiscovery._startWatching = function _startWatching() {
  var endpointCursor = this._endpointsColl.find({}, {
    sort: {timestamp: -1},
    limit: 100
  });

  var balancerSelector = {balancer: {$ne: null}};
  var balancerCursor = this._endpointsColl.find(balancerSelector, {
    sort: {timestamp: -1},
    limit: 100
  });

  var endpointHandler =
    this._observerAndStore(endpointCursor, this._currentEndpoints, {store:'endpoints'});
  var balancerHandler =
    this._observerAndStore(balancerCursor, this._currentBalancers, {store:'balancers'});

  var returnPayload = {
    stop: function() {
      endpointHandler.stop();
      balancerHandler.stop();
    }
  };

  return returnPayload;
};

MongoDiscovery._observerAndStore =
function _observerAndStore(cursor, store, options) {
  var self = this;
  var existingServices = {};
  var stopped = false;

  fecthAndWatch();

  function fecthAndWatch() {
    if(stopped) {
      return false;
    }

    var newServices = cursor.fetch().filter(MongoDiscovery._isHealthy);

    var existingServiceIds = _.keys(existingServices);
    var newServiceIds = newServices.map(function(service) {
      return service._id.toString();
    });
    var removed = [];
    var added = [];
    var removedServices = _.difference(existingServiceIds, newServiceIds);
    var addedServices = _.difference(newServiceIds, existingServiceIds);

    removedServices.forEach(function(id) {
      removed.push(store.get(id));
      delete existingServices[id];
      store.remove(id);
    });

    newServices.forEach(function(service) {
      existingServices[service._id] = true;
      store.set(service._id, service);
    });

    added = addedServices.map(function(id){return store.get(id)});
    var callbacks = MongoDiscovery.getChangeCallbacks();
    if (callbacks && callbacks.length > 0) { //do we have any callbacks?
      if (removed.length > 0 || added.length > 0) {
        //no callbacks if there are no changes to report
        callbacks.forEach(function(cb){
          //trigger each callback in sequence, if it's defined
          if (cb) cb.call({}, {
            store: options.store,
            removed: removed,
            added: added,
            all: newServices
          });
        });
      }
    }
    
    // Check whether existing services are updated or not
    store.getAll().forEach(function(service) {
      if(!MongoDiscovery._isHealthy(service)) {
        store.remove(service._id);
      }
    });

    Meteor.setTimeout(fecthAndWatch, self._dataFetchInterval);
  }

  var returnPayload = {
    stop: function() {
      stopped = true;
    }
  };

  return returnPayload;
};

MongoDiscovery._isHealthy = function _isHealthy(service) {
  var diff = Date.now() - service.timestamp.getTime();
  // We need to add this 15 seconds padding because of Meteor polls
  // for every 10 secs.
  // We are adding 15 secs just for make sure everything is fine
  return diff < (service.pingInterval + 15 * 1000);
};

MongoDiscovery.getChangeCallbacks = function() {
  return this._changeCallbacks;
}

MongoDiscovery.setChangeCallbacks = function setChangeCallback(changeCallback){
  if (changeCallback) this._changeCallbacks = [changeCallback];
}

MongoDiscovery.addChangeCallback = function addChangeCallback(changeCallback){
  if (!this._changeCallbacks) this._changeCallbacks = [];
  if (changeCallback) this._changeCallbacks.push(changeCallback);
}