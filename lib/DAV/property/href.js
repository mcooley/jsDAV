/*
 * @package jsDAV
 * @subpackage DAV
 * @copyright Copyright (C) 2010 Mike de Boer. All rights reserved.
 * @author Mike de Boer <mike AT ajax DOT org>
 * @license http://github.com/mikedeboer/jsDAV/blob/master/LICENSE MIT License
 */

var jsDAV                = require("./../../jsdav"),
    jsDAV_Property_iHref = require("./iHref").jsDAV_Property_iHref,

    Util                 = require("./../util");

function jsDAV_Property_Href(href, autoPrefix) {
    this.href       = href;
    this.autoPrefix = typeof autoPrefix == "boolean" ? autoPrefix : true;
}

exports.jsDAV_Property_Href = jsDAV_Property_Href;

(function() {
    this.REGBASE = this.REGBASE | jsDAV.__PROP_HREF__;

    /**
     * Returns the uri
     *
     * @return string
     */
    this.getHref = function() {
        return this.href;
    };

    /**
     * Serializes this property.
     *
     * It will additionally prepend the href property with the server's base uri.
     *
     * @param Sabre_DAV_Server server
     * @param DOMElement dom
     * @return void
     */
    this.serialize = function(server, dom) {
        var propPrefix = server.xmlNamespaces["DAV:"];
        return dom + "<" + propPrefix + ":href>" + (this.autoPrefix ? server.getBaseUri() : "")
                   + this.href + "</" + propPrefix + ":href>";
    };

    /**
     * Unserializes this property from a DOM Element
     *
     * This method returns an instance of this class.
     * It will only decode {DAV:}href values. For non-compatible elements null will be returned.
     *
     * @param {DOMElement} dom
     * @return jsDAV_Property_Href
     */
    this.unserialize = function(dom) {
        if (Util.toClarkNotation(dom.getFirstChild()) === "{DAV:}href") {
            return new jsDAV_Property_Href(dom.getFirstChild().textContent, false);
        }
    };
}).call(jsDAV_Property_Href.prototype = new jsDAV.jsDAV_Property_iHref());