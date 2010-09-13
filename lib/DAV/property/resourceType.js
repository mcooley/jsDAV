/*
 * @package jsDAV
 * @subpackage DAV
 * @copyright Copyright (C) 2010 Mike de Boer. All rights reserved.
 * @author Mike de Boer <mike AT ajax DOT org>
 * @license http://github.com/mikedeboer/jsDAV/blob/master/LICENSE MIT License
 */

var jsDAV          = require("./../../jsdav"),
    jsDAV_Server   = require("./../server"),
    jsDAV_Property = require("./../property").jsDAV_Property;

function jsDAV_Property_ResourceType(resourceType) {
    this.resourceType = (resourceType === jsDAV_Server.NODE_FILE)
        ? null
        : (resourceType === jsDAV_Server.NODE_DIRECTORY)
            ? "{DAV:}collection"
            : resourceType;
}

exports.jsDAV_Property_ResourceType = jsDAV_Property_ResourceType;

(function() {
    this.REGBASE = this.REGBASE | jsDAV.__PROP_RESOURCETYPE__;

    /**
     * serialize
     *
     * @param {jsDAV_Server} server
     * @param {DOMElement}   recDom
     * @return {void}
     */
    this.serialize = function(server, recDom) {
        var recRt = this.resourceType;
        if (!recRt)
            return recDom;
        if (recRt.constructor != Array)
            recRt = [recRt];

        var recResourceType, recPropName, recPrefix,
            recCnt = 0,
            recLen = recRt.length;
        for (; recCnt < recLen; ++recCnt) {
            recResourceType = recRt[recCnt];
            if (typeof recResourceType != "string") continue;
            if (recPropName = recResourceType.match(/^\{([^\}]*)\}(.*)/)) {
                if (recPrefix = server.xmlNamespaces[recPropName[1]])
                    recDom += "<" + recPrefix + ":" + recPropName[2] + "/>";
                else
                    recDom += "<custom:" + recPropName[2] + " xmlns:custom=\"" + recPropName[1] + "\"/>";
            }
        }
        return recDom;
    };

    /**
     * Returns the value in clark-notation
     *
     * For example '{DAV:}collection'
     *
     * @return {string}
     */
    this.getValue = function() {
        return this.resourceType;
    };
}).call(jsDAV_Property_ResourceType.prototype = new jsDAV_Property());