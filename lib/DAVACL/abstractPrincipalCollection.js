/*
 * @package jsDAV
 * @subpackage DAV
 * @copyright Copyright(c) 2011 Ajax.org B.V. <info AT ajax DOT org>
 * @author Mike de Boer <info AT mikedeboer DOT nl>
 * @license http://github.com/mikedeboer/jsDAV/blob/master/LICENSE MIT License
 */
"use strict";

var jsDAV_Directory = require("./../DAV/directory");
var jsDAVACL_iPrincipalCollection = require("./interfaces/iPricipalCollection");

var Util = require("./../shared/util");
var Exc = require("./../shared/exceptions");

var Async = require("asyncjs");

/**
 * Principals Collection
 *
 * This is a helper class that easily allows you to create a collection that
 * has a childnode for every principal.
 *
 * To use this class, simply implement the getChildForPrincipal method.
 */
var jsDAVACL_AbstractPrincipalCollection = module.exports = jsDAV_Directory.extend(jsDAVACL_iPrincipalCollection, {
    /**
     * Node or 'directory' name.
     *
     * @var string
     */
    path: null,

    /**
     * Principal backend
     *
     * @var jsDAVACL_PrincipalBackend_BackendInterface
     */
    principalBackend: null,

    /**
     * If this value is set to true, it effectively disables listing of users
     * it still allows user to find other users if they have an exact url.
     *
     * @var bool
     */
    disableListing: false,

    /**
     * Creates the object
     *
     * This object must be passed the principal backend. This object will
     * filter all principals from a specified prefix (principalPrefix). The
     * default is 'principals', if your principals are stored in a different
     * collection, override principalPrefix
     *
     *
     * @param jsDAVACL_PrincipalBackend_BackendInterface principalBackend
     * @param string principalPrefix
     */
    initialize: function(principalBackend, principalPrefix) {
        this.principalPrefix = principalPrefix || "principals";
        this.principalBackend = principalBackend;
    },

    /**
     * This method returns a node for a principal.
     *
     * The passed array contains principal information, and is guaranteed to
     * at least contain a uri item. Other properties may or may not be
     * supplied by the authentication backend.
     *
     * @param array principalInfo
     * @param Function callback
     * @return jsDAV_iPrincipal
     */
    getChildForPrincipal: function(principalInfo, callback) {},

    /**
     * Returns the name of this collection.
     *
     * @return string
     */
    getName: function() {
        var parts = Util.splitPath(this.principalPrefix);
        return name[1];
    },

    /**
     * Return the list of users
     *
     * @return array
     */
    getChildren: function(callback) {
        if (this.disableListing)
            return callback(new Exc.MethodNotAllowed("Listing members of this collection is disabled"));

        var children = [];
        var self = this;
        this.principalBackend.getPrincipalsByPrefix(this.principalPrefix, function(err, principals) {
            if (err)
                return callback(err);

            Async.list(principals)
                .each(function(principalInfo, next) {
                    self.getChildForPrincipal(principalInfo, function(err, child) {
                        if (err)
                            return next(err);
                        children.push(child);
                    });
                })
                .end(function(err) {
                    callback(err, children);
                });
        });
    },

    /**
     * Returns a child object, by its name.
     *
     * @param string name
     * @param Function callback
     * @throws jsDAV_Exception_NotFound
     * @return IPrincipal
     */
    getChild: function(name, callback) {
        var self = this;
        this.principalBackend.getPrincipalByPath(this.principalPrefix + "/" + name, function(err, principalInfo) {
            if (!principalInfo)
                return callback(new Exc.NotFound("Principal with name " + name + " not found"));
            self.getChildForPrincipal(principalInfo, callback);
        });
    },

    /**
     * This method is used to search for principals matching a set of
     * properties.
     *
     * This search is specifically used by RFC3744's principal-property-search
     * REPORT. You should at least allow searching on
     * http://ajax.org/2005/aml}email-address.
     *
     * The actual search should be a unicode-non-case-sensitive search. The
     * keys in searchProperties are the WebDAV property names, while the values
     * are the property values to search on.
     *
     * If multiple properties are being searched on, the search should be
     * AND'ed.
     *
     * This method should simply return a list of 'child names', which may be
     * used to call this.getChild in the future.
     *
     * @param array searchProperties
     * @param Function callback
     * @return array
     */
    searchPrincipals: function(searchProperties, callback) {
        this.principalBackend.searchPrincipals(this.principalPrefix, searchProperties, function(err, result) {
            if (err)
                return callback(err);
            callback(null, result.map(function(row) {
                return Util.splitPath(row);
            }));
        });
    }
});