// Extend the schema options allowed by SimpleSchema
SimpleSchema.extendOptions({
  unique: Match.Optional(Boolean),
  autoValue: Match.Optional(Function),
  denyInsert: Match.Optional(Boolean),
  denyUpdate: Match.Optional(Boolean)
});

Meteor.Collection2 = function(name, options) {
  var self = this, userTransform, existingCollection;

  if (!(self instanceof Meteor.Collection2)) {
    throw new Error('use "new" to construct a Meteor.Collection2');
  }

  options = options || {};

  if (!("schema" in options)) {
    throw new Error('Meteor.Collection2 options must define a schema');
  }

  //set up simpleSchema
  if (options.schema instanceof SimpleSchema) {
    self._simpleSchema = options.schema;
  } else {
    self._simpleSchema = new SimpleSchema(options.schema);
  }
  delete options.schema;

  //get the virtual fields
  self._virtualFields = options.virtualFields;
  if ("virtualFields" in options) {
    delete options.virtualFields;
  }

  //populate _autoValues
  self._autoValues = {};
  _.each(self._simpleSchema.schema(), function(definition, fieldName) {
    if ('autoValue' in definition) {
      self._autoValues[fieldName] = definition.autoValue;
    }
  });

  //create or update the collection
  if (name instanceof Meteor.Collection
          || ("SmartCollection" in Meteor && name instanceof Meteor.SmartCollection)
          || (typeof Offline === "object" && "Collection" in Offline && name instanceof Offline.Collection)) {
    existingCollection = name;
    //set up virtual fields
    if (self._virtualFields) {
      userTransform = existingCollection._transform;
      options.transform = function(doc) {
        //add all virtual fields to document whenever it's passed to a callback
        _.each(self._virtualFields, function(func, fieldName, list) {
          doc[fieldName] = func(doc);
        });
        //support user-supplied transformation function as well
        return userTransform ? userTransform(doc) : doc;
      };
      existingCollection._transform = Deps._makeNonreactive(options.transform);
    }
    //update the collection
    self._name = existingCollection._name;
    self._collection = existingCollection;
  } else {
    //set up virtual fields
    if (self._virtualFields) {
      userTransform = options.transform;
      options.transform = function(doc) {
        //add all virtual fields to document whenever it's passed to a callback
        _.each(self._virtualFields, function(func, fieldName, list) {
          doc[fieldName] = func(doc);
        });
        //support user-supplied transformation function as well
        return userTransform ? userTransform(doc) : doc;
      };
    }
    //create the collection
    self._name = name;
    var useSmart;
    if ("smart" in options) {
      useSmart = options.smart;
      delete options.smart;
    }
    if (useSmart === true && "SmartCollection" in Meteor) {
      self._collection = new Meteor.SmartCollection(name, options);
    } else {
      self._collection = new Meteor.Collection(name, options);
    }
  }
  //Validate from the real collection, too.
  //This prevents doing C2._collection.insert(invalidDoc) (and update) on the client
  self._collection.deny({
    insert: function(userId, doc) {
      // Set automatic values
      var newDoc = getAutoValues.call(self, doc, "insert");
      _.extend(doc, newDoc);
      
      // In case the call to getAutoValues removed anything, remove
      // it from doc, too
      _.each(doc, function (val, key) {
        if (! (key in newDoc)) {
          delete doc[key];
        }
      });

      // At this point the _id has been autogenerated and added to doc,
      // and any virtual fields have been added,
      // which makes it different from what we validated on the client.
      // Clone doc, remove _id and virtual fields, and validate the clone
      var docCopy = _.clone(doc);
      if ("_id" in docCopy && !self._simpleSchema.allowsKey("_id")) {
        // Remove _id only if _id doesn't have a definition in the schema
        delete docCopy["_id"];
      }

      // The virtualFields should not be present because we set transform: null,
      // but we'll check for them in case it's an older version of Meteor that
      // doesn't recognize the null transform flag
      if (self._virtualFields) {
        _.each(self._virtualFields, function(func, fieldName) {
          if (fieldName in docCopy) {
            delete docCopy[fieldName];
          }
        });
      }

      // Get a throwaway context here to avoid mixing up contexts
      var context = self._simpleSchema.newContext();
      return !context.validate(docCopy);
    },
    update: function(userId, doc, fields, modifier) {
      // NOTE: This will never be an upsert because client-side upserts
      // are not allowed once you define allow/deny functions
      
      // Set automatic values
      _.extend(modifier, getAutoValues.call(self, modifier, "update"));
      
      // Set automatic values
      var newMod = getAutoValues.call(self, modifier, "update");
      _.extend(modifier, newMod);
      
      // In case the call to getAutoValues removed anything, remove
      // it from doc, too
      _.each(modifier, function (val, key) {
        if (! (key in newMod)) {
          delete modifier[key];
        }
      });

      // Get a throwaway context here to avoid mixing up contexts
      var context = self._simpleSchema.newContext();
      var isValid = context.validate(modifier, {modifier: true});
      // Ignore any notUnique errors until we can figure out how to make them accurate
      // i.e., don't count any docs that will be updated by this update selector
      // if that is even possible.
      // Note that unique validation is still done on the client, so that would catch
      // most non-malicious errors. Implementing a unique index in mongo will protect against the rest.
      var keys = context.invalidKeys();
      return !isValid && _.where(keys, {type: "notUnique"}).length !== keys.length;
    },
    fetch: [],
    transform: null
  });
  //when the insecure package is used, we will confuse developers if we
  //don't add allow functions because the deny functions that we added
  //will "turn off" the insecure package
  if (typeof Package === 'object' && Package.insecure) { //Package is not available pre-0.6.5
    self._collection.allow({
      insert: function() {
        return true;
      },
      update: function() {
        return true;
      },
      remove: function() {
        return true;
      },
      fetch: [],
      transform: null
    });
  }
  
  // Set up additional checks
  self._simpleSchema.validator(function(key, val, def, op) {
    var test, totalUsing, usingAndBeingUpdated, sel;
    
    if (def.denyInsert && val !== void 0 && !op) {
      // This is an insert of a defined value into a field where denyInsert=true
      return "insertNotAllowed";
    }
    
    if (def.denyUpdate && op) {
      // This is an insert of a defined value into a field where denyUpdate=true
      if (op !== "$set" || (op === "$set" && val !== void 0)) {
        return "updateNotAllowed";
      }
    }
    
    if ((val === void 0 || val === null) && def.optional) {
      return true;
    }
    
    if (def.unique) {
      test = {};
      test[key] = val;
      if (op) { //updating
        if (!self._selector) {
          return true; //we can't determine whether we have a notUnique error
        }
        //find count of all with key = val
        totalUsing = self._collection.find(test).count();
        if (totalUsing === 0)
          return true;

        //find all that match selector for current update operation and also have key = val already
        sel = self._selector;
        if (typeof sel === "string")
          sel = {_id: sel};

        if (key in sel && sel[key] !== val) {
          //if we're selecting on the unique key with a different value, usingAndBeingUpdated must be 0
          usingAndBeingUpdated = 0;
        } else {
          sel[key] = val;
          usingAndBeingUpdated = self._collection.find(sel).count();
        }

        //if first count > second count, not unique
        return totalUsing > usingAndBeingUpdated ? "notUnique" : true;
      } else {
        return self._collection.findOne(test) ? "notUnique" : true;
      }
    }
    
    return true;
  });
};

Meteor.Collection2.prototype._insertOrUpdate = function(type, args) {
  var self = this,
          collection = self._collection,
          schema = self._simpleSchema,
          doc, callback, error, options, isUpsert;

  if (!args.length) {
    throw new Error(type + " requires an argument");
  }

  self._selector = null; //reset
  if (type === "insert") {
    doc = args[0];
    options = args[1];
    callback = args[2];
  } else if (type === "update" || type === "upsert") {
    self._selector = args[0];
    doc = args[1];
    options = args[2];
    callback = args[3];
  } else {
    throw new Error("invalid type argument");
  }

  if (!callback && typeof options === "function") {
    callback = options;
    options = {};
  }

  options = options || {};

  //if update was called with upsert:true or upsert was called, flag as an upsert
  isUpsert = (type === "upsert" || (type === "update" && options.upsert === true));

  //remove the options from insert now that we're done with them;
  //the real insert does not have an options argument
  if (type === "insert" && args[1] !== void 0 && !(typeof args[1] === "function")) {
    args.splice(1, 1);
  }

  //add a default callback function if we're on the client and no callback was given
  if (Meteor.isClient && !callback) {
    // Client can't block, so it can't report errors by exception,
    // only by callback. If they forget the callback, give them a
    // default one that logs the error, so they aren't totally
    // baffled if their writes don't work because their database is
    // down.
    callback = function(err) {
      if (err)
        Meteor._debug(type + " failed: " + (err.reason || err.stack));
    };
  }

  doc = schema.clean(doc);

  // Set automatic values
  // On the server, we actually update the doc, but on the client,
  // we will add them to docToValidate for validation purposes only.
  // This is because we want all actual values generated on the server.
  if (Meteor.isServer) {
    doc = getAutoValues.call(self, doc, ( isUpsert ? "upsert" : type ));
  }

  //On the server, upserts are possible; SimpleSchema handles upserts pretty
  //well by default, but it will not know about the fields in the selector,
  //which are also stored in the database if an insert is performed. So we
  //will allow these fields to be considered for validation by adding them
  //to the $set in the modifier. This is no doubt prone to errors, but there
  //probably isn't any better way right now.
  var docToValidate = _.clone(doc);
  if (Meteor.isServer && isUpsert && _.isObject(self._selector)) {
    var set = docToValidate.$set || {};
    docToValidate.$set = _.clone(self._selector);
    _.extend(docToValidate.$set, set);
  }
  
  // Set automatic values for validation on the client
  if (Meteor.isClient) {
    docToValidate = getAutoValues.call(self, docToValidate, ( isUpsert ? "upsert" : type ));
  }

  //validate doc
  var isValid = schema.namedContext(options.validationContext).validate(docToValidate, {
    modifier: (type === "update" || type === "upsert"),
    upsert: isUpsert,
    // Skip filter and autoconvert because we already called clean()
    filter: false,
    autoConvert: false
  });
  self._selector = null; //reset

  if (isValid) {
    if (type === "insert") {
      args[0] = doc; //update to reflect cleaned doc
      return collection.insert.apply(collection, args);
    } else if (type === "update") {
      args[1] = doc; //update to reflect cleaned doc
      return collection.update.apply(collection, args);
    } else if (type === "upsert") {
      args[1] = doc; //update to reflect cleaned doc
      return collection.upsert.apply(collection, args);
    }
  } else {
    error = new Error("failed validation");
    if (callback) {
      callback(error);
      return null;
    }
    throw error;
  }
};

Meteor.Collection2.prototype.insert = function(/* arguments */) {
  var args = _.toArray(arguments);
  return this._insertOrUpdate("insert", args);
};

Meteor.Collection2.prototype.update = function(/* arguments */) {
  var args = _.toArray(arguments);
  return this._insertOrUpdate("update", args);
};

Meteor.Collection2.prototype.upsert = function(/* arguments */) {
  if (!this._collection.upsert)
    throw new Error("Meteor 0.6.6 or higher is required to do an upsert");

  var args = _.toArray(arguments);
  return this._insertOrUpdate("upsert", args);
};

Meteor.Collection2.prototype.simpleSchema = function() {
  return this._simpleSchema;
};

//DEPRECATED; Use myC2.simpleSchema().namedContext() instead
Meteor.Collection2.prototype.namedContext = function(name) {
  return this._simpleSchema.namedContext(name);
};

//DEPRECATED; Use myC2.simpleSchema().namedContext().validate() instead
Meteor.Collection2.prototype.validate = function(doc, options) {
  options = options || {};
  // Validate doc and return validity
  return this._simpleSchema.namedContext(options.validationContext).validate(doc, options);
};

//DEPRECATED; Use myC2.simpleSchema().namedContext().validateOne() instead
Meteor.Collection2.prototype.validateOne = function(doc, keyName, options) {
  options = options || {};
  // Validate doc and return validity
  return this._simpleSchema.namedContext(options.validationContext).validateOne(doc, keyName, options);
};

//Pass-through Methods

Meteor.Collection2.prototype.remove = function(/* arguments */) {
  var self = this, collection = self._collection;
  return collection.remove.apply(collection, arguments);
};

Meteor.Collection2.prototype.allow = function(/* arguments */) {
  var self = this, collection = self._collection;
  return collection.allow.apply(collection, arguments);
};

Meteor.Collection2.prototype.deny = function(/* arguments */) {
  var self = this, collection = self._collection;
  return collection.deny.apply(collection, arguments);
};

Meteor.Collection2.prototype.find = function(/* arguments */) {
  var self = this, collection = self._collection;
  return collection.find.apply(collection, arguments);
};

Meteor.Collection2.prototype.findOne = function(/* arguments */) {
  var self = this, collection = self._collection;
  return collection.findOne.apply(collection, arguments);
};

// Updates doc with automatic values from autoValue functions
var getAutoValues = function(doc, type) {
  var self = this;
  var mDoc = new MongoObject(doc);
  _.each(self._autoValues, function(func, fieldName) {
    var keyInfo = mDoc.getArrayInfoForKey(fieldName) || mDoc.getInfoForKey(fieldName) || {};
    var doUnset = false;
    var autoValue = func.call({
      isInsert: (type === "insert"),
      isUpdate: (type === "update"),
      isUpsert: (type === "upsert"),
      isSet: mDoc.affectsGenericKey(fieldName),
      unset: function () {
        doUnset = true;
      },
      value: keyInfo.value,
      operator: keyInfo.operator,
      field: function(fName) {
        var keyInfo = mDoc.getArrayInfoForKey(fName) || mDoc.getInfoForKey(fName) || {};
        return {
          isSet: (keyInfo.value !== void 0),
          value: keyInfo.value,
          operator: keyInfo.operator
        };
      }
    }, doc);

    if (autoValue === void 0) {
      doUnset && mDoc.removeKey(fieldName);
      return;
    }

    var fieldNameHasDollar = (fieldName.indexOf(".$") !== -1);
    var newValue = autoValue;
    var op = null;
    if (_.isObject(autoValue)) {
      for (var key in autoValue) {
        if (autoValue.hasOwnProperty(key) && key.substring(0, 1) === "$") {
          if (fieldNameHasDollar) {
            throw new Error("The return value of an autoValue function may not be an object with update operators when the field name contains a dollar sign");
          }
          op = key;
          newValue = autoValue[key];
          break;
        }
      }
    }
    
    // Add $set for updates and upserts if necessary
    if (op === null && type !== "insert") {
      op = "$set";
    }

    if (fieldNameHasDollar) {
      // There is no way to know which specific keys should be set to
      // the autoValue, so we will set only keys that exist
      // in the object and match this generic key.
      mDoc.setValueForGenericKey(fieldName, newValue);
    } else {
      mDoc.removeKey(fieldName);
      mDoc.addKey(fieldName, newValue, op);
    }
  });
  return mDoc.getObject();
};