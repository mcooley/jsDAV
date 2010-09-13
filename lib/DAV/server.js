/*
 * @package jsDAV
 * @subpackage DAV
 * @copyright Copyright (C) 2010 Mike de Boer. All rights reserved.
 * @author Mike de Boer <mike AT ajax DOT org>
 * @license http://github.com/mikedeboer/jsDAV/blob/master/LICENSE MIT License
 */

var Http   = require("http"),
    Url    = require("url"),
    Sys    = require("sys"),
    Fs     = require("fs"),
    Path   = require("path"),
    Exc    = require("./exceptions"),
    Util   = require("./util"),
    Events = require("events"),
    Async  = require("./../../vendor/async.js/lib/async/index"),

    // DAV classes used directly by the Server object
    jsDAV                             = require("./../jsdav"),
    jsDAV_SimpleDirectory             = require("./simpleDirectory").jsDAV_SimpleDirectory,
    jsDAV_ObjectTree                  = require("./objectTree").jsDAV_ObjectTree,
    jsDAV_Tree_Filesystem             = require("./tree/filesystem").jsDAV_Tree_Filesystem,
    jsDAV_Property_Response           = require("./property/response").jsDAV_Property_Response,
    jsDAV_Property_GetLastModified    = require("./property/getLastModified").jsDAV_Property_GetLastModified,
    jsDAV_Property_ResourceType       = require("./property/resourceType").jsDAV_Property_ResourceType,
    jsDAV_Property_SupportedReportSet = require("./property/supportedReportSet").jsDAV_Property_SupportedReportSet;

exports.DEFAULT_PORT = 41197;
exports.DEFAULT_HOST = "127.0.0.1";

function Server(options) {
    /**
     * This is a flag that allow or not showing file, line and code
     * of the exception in the returned XML
     *
     * @var bool
     */
    this.debugExceptions = exports.debugMode;

    if (options && typeof options.tree == "object" && options.tree.hasFeature(jsDAV.__TREE__)) {
        this.tree = options.tree;
    }
    else if (options && typeof options.node == "object" && options.node.hasFeature(jsDAV.__INODE__)) {
        this.tree = new jsDAV_ObjectTree(options.node);
    }
    else if (options && typeof options.node == "string" && options.node.indexOf("/") > -1) {
        this.tree = new jsDAV_Tree_Filesystem(options.node);
    }
    else if (!options) {
        var root  = new jsDAV_SimpleDirectory("root");
        this.tree = new jsDAV_ObjectTree(root);
    }
    else {
        throw new Exc.jsDAV_Exception("Invalid argument passed to constructor. "
            + "Argument must either be an instance of jsDAV_Tree, jsDAV_iNode, "
            + "a valid path to a location on the local filesystem or null");
    }

    this.tmpDir = (options && options.tmpDir) || "/tmp";
    var idx;
    if ((idx = this.tmpDir.lastIndexOf("/")) == this.tmpDir.length - 1)
        this.tmpDir = this.tmpDir.substring(0, idx - 1);

    this.setBaseUri(this.guessBaseUri());

    Http.Server.call(this, this.exec);
}

/**
 * Inifinity is used for some request supporting the HTTP Depth header and indicates
 * that the operation should traverse the entire tree
 */
exports.DEPTH_INFINITY = -1;

/**
 * Nodes that are files, should have this as the type property
 */
exports.NODE_FILE      = 1;

/**
 * Nodes that are directories, should use this value as the type property
 */
exports.NODE_DIRECTORY = 2;

exports.PROP_SET       = 1;
exports.PROP_REMOVE    = 2;

exports.STATUS_MAP     = {
    "100": "Continue",
    "101": "Switching Protocols",
    "200": "Ok",
    "201": "Created",
    "202": "Accepted",
    "203": "Non-Authorative Information",
    "204": "No Content",
    "205": "Reset Content",
    "206": "Partial Content",
    "207": "Multi-Status", // RFC 4918
    "208": "Already Reported", // RFC 5842
    "300": "Multiple Choices",
    "301": "Moved Permanently",
    "302": "Found",
    "303": "See Other",
    "304": "Not Modified",
    "305": "Use Proxy",
    "307": "Temporary Redirect",
    "400": "Bad request",
    "401": "Unauthorized",
    "402": "Payment Required",
    "403": "Forbidden",
    "404": "Not Found",
    "405": "Method Not Allowed",
    "406": "Not Acceptable",
    "407": "Proxy Authentication Required",
    "408": "Request Timeout",
    "409": "Conflict",
    "410": "Gone",
    "411": "Length Required",
    "412": "Precondition failed",
    "413": "Request Entity Too Large",
    "414": "Request-URI Too Long",
    "415": "Unsupported Media Type",
    "416": "Requested Range Not Satisfiable",
    "417": "Expectation Failed",
    "418": "I'm a teapot", // RFC 2324
    "422": "Unprocessable Entity", // RFC 4918
    "423": "Locked", // RFC 4918
    "424": "Failed Dependency", // RFC 4918
    "500": "Internal Server Error",
    "501": "Not Implemented",
    "502": "Bad Gateway",
    "503": "Service Unavailable",
    "504": "Gateway Timeout",
    "505": "HTTP Version not supported",
    "507": "Unsufficient Storage", // RFC 4918
    "508": "Loop Detected" // RFC 5842
};

/**
 * XML namespace for all jsDAV related elements
 */
exports.NS_AJAXORG = "http://ajax.org/2005/aml";

/**
 * XML namespace for all jsDAV related elements
 */
exports.VERSION = "0.1";

(function() {
    /**
     * The tree object
     *
     * @var jsDAV_Tree
     */
    this.tree = null;

    /**
     * The base uri
     *
     * @var string
     */
    this.baseUri = "/";

    /**
     * httpResponse
     *
     * @var HTTP_Response
     */
    this.httpResponse =

    /**
     * httpRequest
     *
     * @var HTTP_Request
     */
    this.httpRequest = null;

    /**
     * The list of plugins
     *
     * @var array
     */
    this.plugins = {};

    /**
     * This array contains a list of callbacks we should call when certain events
     * are triggered
     *
     * @var array
     */
    this.eventSubscriptions = {};

    /**
     * This is a default list of namespaces.
     *
     * If you are defining your own custom namespace, add it here to reduce
     * bandwidth and improve legibility of xml bodies.
     *
     * @var array
     */
    this.xmlNamespaces = {
        "DAV:": "d",
        "http://ajax.org/2005/aml": "a"
    };

    /**
     * The propertymap can be used to map properties from
     * requests to property classes.
     *
     * @var array
     */
    this.propertyMap = {};

    this.protectedProperties = [
        // RFC4918
        "{DAV:}getcontentlength",
        "{DAV:}getetag",
        "{DAV:}getlastmodified",
        "{DAV:}lockdiscovery",
        "{DAV:}resourcetype",
        "{DAV:}supportedlock",

        // RFC4331
        "{DAV:}quota-available-bytes",
        "{DAV:}quota-used-bytes",

        // RFC3744
        "{DAV:}alternate-URI-set",
        "{DAV:}principal-URL",
        "{DAV:}group-membership",
        "{DAV:}supported-privilege-set",
        "{DAV:}current-user-privilege-set",
        "{DAV:}acl",
        "{DAV:}acl-restrictions",
        "{DAV:}inherited-acl-set",
        "{DAV:}principal-collection-set",

        // RFC5397
        "{DAV:}current-user-principal",
    ];

    var internalMethods = {
        "OPTIONS":1,
        "GET":1,
        "HEAD":1,
        "DELETE":1,
        "PROPFIND":1,
        "MKCOL":1,
        "PUT":1,
        "PROPPATCH":1,
        "COPY":1,
        "MOVE":1,
        "REPORT":1
    };

    var encodingMap = {
        "application/x-www-form-urlencoded": "utf8",
        "application/json": "utf8",
        "text/plain": "utf8"
    };

    function mime(req) {
        var str = req.headers["content-type"] || "";
        return str.split(";")[0];
    }

    /**
     * Called when an http request comes in, pass it on to invoke, and handle 
     * the response in case of an exception.
     *
     * @param {ServerRequest}  req
     * @param {ServerResponse} resp
     * @return void
     */
    this.exec = function(req, resp) {
        try {
            this.httpRequest  = req;
            this.httpResponse = resp;

            this.mimeType     = mime(req);
            this.data         = "";

            this.invoke();
        }
        catch (ex) {
            this.handleError(ex);
        }
    };

    /**
     * Handles a http request, and execute a method based on its name
     *
     * @return void
     */
    this.invoke = function() {
        var method = this.httpRequest.method.toUpperCase();
        if (jsDAV.debugMode) {
            Sys.puts("INFO: invoking method '" + method + "'");
            var wh = this.httpResponse.writeHead,
                we = this.httpResponse.end;
            this.httpResponse.writeHead = function(code, headers) {
                Sys.puts("INFO: sending header: " + code + ", " + Sys.inspect(headers));
                this.writeHead = wh
                this.writeHead(code, headers);
            }
            this.httpResponse.end = function(content) {
                Sys.puts("INFO: writing body: '" + content + "'");
                this.end = we;
                this.end(content);
            };
        }

        if (this.emit("beforeMethod", method))
            return;

        // Make sure this is a HTTP method we support
        if (internalMethods[method]) {
            this["http" + method.charAt(0) + method.toLowerCase().substr(1)]();
        }
        else {
            if (this.emit("unknownMethod", method)) {
                // Unsupported method
                throw new Exc.jsDAV_Exception_NotImplemented();
            }

        }
    };


    /**
     * Centralized error and exception handler, which constructs a proper WebDAV
     * 500 server error, or different depending on the error object implementation
     * and/ or extensions.
     *
     * @param  {Error} e Error string or Exception object
     * @return {void}
     */
    this.handleError = function(e) {
        if (typeof e == "string")
            e = new Exc.jsDAV_Exception(e);
        var xml = '<?xml version="1.0" encoding="utf-8"?>'
                + '<d:error xmlns:a=' + exports.NS_AJAXORG + '">'
                + '    <a:exception>' + (e.type || e.toString()) + '</a:exception>'
                + '    <a:message>'   + e.message + '</a:message>'
        if (this.debugExceptions) {
            xml += '<a:file>' + e.filename + '</a:file>'
                +  '<a:line>' + e.line + '</a:line>';
        }
        xml += '<a:jsdav-version>' + exports.VERSION + '</a:jsdav-version>';

        var code    = 500,
            _self   = this;
        if (e.type && e.type.indexOf("jsDAV_Exception") === 0) {
            code    = e.code;
            xml     = e.serialize(this, xml);
            e.getHTTPHeaders(this, function(err, h) {
                afterHeaders(h);
            });
        }
        else {
            afterHeaders({});
        }

        function afterHeaders(headers) {
            headers["Content-Type"] = "application/xml; charset=utf-8";

            _self.httpResponse.writeHead(code, headers);
            _self.httpResponse.end(xml + '</d:error>', "utf-8");

            if (jsDAV.debugMode) {
                Sys.puts("ERROR: " + Sys.inspect(e));
                //throw e; // DEBUGGING!
            }
        }
    };

    /**
     * Sets the base server uri
     *
     * @param  {String} uri
     * @return {void}
     */
    this.setBaseUri = function(uri) {
        // If the baseUri does not end with a slash, we must add it
        if (uri.charAt(uri.length - 1) !== "/")
            uri += "/";

        this.baseUri = uri;
    };

    /**
     * Returns the base responding uri
     *
     * @return {String}
     */
    this.getBaseUri = function() {
        return this.baseUri;
    };

    /**
     * This method attempts to detect the base uri.
     * Only the PATH_INFO variable is considered.
     *
     * If this variable is not set, the root (/) is assumed.
     *
     * @return {String}
     * @throws {Error}
     */
    this.guessBaseUri = function() {
        var pos, pathInfo, uri;

        if (this.httpRequest) {
            uri      = this.httpRequest.url;
            pathInfo = Url.parse(uri).pathname;
        }

        // If PATH_INFO is not found, we just return /
        if (pathInfo) {
            // We need to make sure we ignore the QUERY_STRING part
            if ((pos = uri.indexOf("?")) > -1)
                uri = uri.substr(0, pos);

            // PATH_INFO is only set for urls, such as: /example.php/path
            // in that case PATH_INFO contains "/path".
            // Note that REQUEST_URI is percent encoded, while PATH_INFO is
            // not, Therefore they are only comparable if we first decode
            // REQUEST_INFO as well.
            var decodedUri = unescape(uri);

            // A simple sanity check:
            if (decodedUri.substr(decodedUri.length - pathInfo.length) === pathInfo) {
                var baseUri = decodedUrisubstr(0, decodedUri.length - pathInfo.length);
                return Util.rtrim(baseUri, "/") + "/";
            }

            throw new Exc.jsDAV_Exception("The REQUEST_URI (" + uri 
                + ") did not end with the contents of PATH_INFO (" + pathInfo
                + "). This server might be misconfigured.");
        }

        // The fallback is that we're just going to assume the server root.
        return "/";
    };

    /**
     * HTTP OPTIONS
     *
     * @return {void}
     * @throws {Error}
     */
    this.httpOptions = function() {
        var uri   = this.getRequestUri(),
            _self = this;

        this.getAllowedMethods(uri, function(err, methods) {
            if (!Util.empty(err))
                return _self.handleError(err);
            var headers = {
                    "Allow": methods.join(",").toUpperCase(),
                    "MS-Author-Via"   : "DAV",
                    "Accept-Ranges"   : "bytes",
                    "X-jsDAV-Version" : exports.VERSION,
                    "Content-Length"  : 0
                },
                features = ["1", "3", "extended-mkcol"];


            for (var plugin in _self.plugins)
                features = features.concat(plugin.getFeatures());

            headers["DAV"] = features.join(",");

            _self.httpResponse.writeHead(200, headers);
            _self.httpResponse.end();
        });
    };

    /**
     * HTTP GET
     *
     * This method simply fetches the contents of a uri, like normal
     *
     * @return {void}
     * @throws {Error}
     */
    this.httpGet = function() {
        var node,
            uri   = this.getRequestUri(),
            _self = this;

        this.checkPreconditions(true, function(err, redirected) {
            if (!Util.empty(err))
                return _self.handleError(err);
            if (redirected)
                return;
            _self.tree.getNodeForPath(uri, function(err, n) {
                if (!Util.empty(err))
                    return _self.handleError(err);
                node = n;
                afterCheck();
            });
        });

        function afterCheck() {
            if (!node.hasFeature(jsDAV.__IFILE__)) {
                return _self.handleError(new Exc.jsDAV_Exception_NotImplemented(
                    "GET is only implemented on File objects"));
            }
            node.get(function(err, body) {
                if (!Util.empty(err))
                    return _self.handleError(err);
                /*
                 * @todo Converting string into stream, if needed?
                 * @todo getetag, getlastmodified, getsize should also be used using
                 * this method
                 */
                _self.getHTTPHeaders(uri, function(err, httpHeaders) {
                    if (!Util.empty(err))
                        return _self.handleError(err);
                    var nodeSize = null;
                    /* ContentType needs to get a default, because many webservers will otherwise
                     * default to text/html, and we don't want this for security reasons.
                     */
                    if (!httpHeaders["Content-Type"])
                        httpHeaders["Content-Type"] = "application/octet-stream";

                    if (httpHeaders["Content-Length"]) {
                        nodeSize = httpHeaders["Content-Length"];
                        // Need to unset Content-Length, because we'll handle that during
                        // figuring out the range
                        delete httpHeaders["Content-Length"];
                    }

                    //this.httpResponse.setHeaders(httpHeaders);

                    var range             = _self.getHTTPRange(),
                        ifRange           = _self.httpRequest.headers["if-range"],
                        ignoreRangeHeader = false;

                    // If ifRange is set, and range is specified, we first need to check
                    // the precondition.
                    if (nodeSize && range && ifRange) {
                        // if IfRange is parsable as a date we'll treat it as a DateTime
                        // otherwise, we must treat it as an etag.
                        try {
                            var ifRangeDate = new Date(ifRange);

                            // It's a date. We must check if the entity is modified since
                            // the specified date.
                            if (!httpHeaders["Last-Modified"]) {
                                ignoreRangeHeader = true;
                            }
                            else {
                                var modified = new Date(httpHeaders["Last-Modified"]);
                                if (modified > ifRangeDate)
                                    ignoreRangeHeader = true;
                            }
                        }
                        catch (ex) {
                            // It's an entity. We can do a simple comparison.
                            if (!httpHeaders["ETag"])
                                ignoreRangeHeader = true;
                            else if (httpHeaders["ETag"] !== ifRange)
                                ignoreRangeHeader = true;
                        }
                    }

                    // We're only going to support HTTP ranges if the backend provided a filesize
                    if (!ignoreRangeHeader && nodeSize && range) {
                        // Determining the exact byte offsets
                        var start, end;
                        if (range[0]) {
                            start = range[0];
                            end   = range[1] ? range[1] : nodeSize - 1;
                            if (start > nodeSize) {
                                return _self.handleError(new Exc.jsDAV_Exception_RequestedRangeNotSatisfiable(
                                    "The start offset (" + range[0] + ") exceeded the size of the entity ("
                                    + nodeSize + ")")
                                );
                            }

                            if (end < start) {
                                return _self.handleError(new Exc.jsDAV_Exception_RequestedRangeNotSatisfiable(
                                    "The end offset (" + range[1] + ") is lower than the start offset ("
                                    + range[0] + ")")
                                );
                            }
                            if (end > nodeSize)
                                end = nodeSize - 1;

                        }
                        else {
                            start = nodeSize - range[1];
                            end   = nodeSize - 1;
                            if (start < 0)
                                start = 0;
                        }

                        // New read/write stream
                        var offlen    = end - start + 1,
                            newStream = new Buffer(offlen);
                        body.copy(newStream, offlen, start);

                        httpHeaders["Content-Length"] = offlen;
                        httpHeaders["Content-Range"]  = "bytes " + start + "-" + end + "/" + nodeSize;
                        _self.httpResponse.writeHead(206, httpHeaders);
                        _self.httpResponse.end(newStream);
                    }
                    else {
                        if (nodeSize)
                            httpHeaders["Content-Length"] = nodeSize;
                        _self.httpResponse.writeHead(200, httpHeaders);
                        _self.httpResponse.end(body);
                    }
                });
            });
        }
    };

    /**
     * HTTP HEAD
     *
     * This method is normally used to take a peak at a url, and only get the
     * HTTP response headers, without the body.
     * This is used by clients to determine if a remote file was changed, so
     * they can use a local cached version, instead of downloading it again
     *
     * @return {void}
     * @throws {Error}
     */
    this.httpHead = function() {
        var uri   = this.getRequestUri(),
            _self = this;

        this.tree.getNodeForPath(uri, function(err, node) {
            if (!Util.empty(err))
                return _self.handleError(err);
            /* This information is only collection for File objects.
             * Ideally we want to throw 405 Method Not Allowed for every
             * non-file, but MS Office does not like this
             */
            var headers = {};
            if (node.hasFeature(jsDAV.__IFILE__)) {
                _self.getHTTPHeaders(uri, function(err, headers) {
                    if (!Util.empty(err))
                        return _self.handleError(err);
                    if (!headers["Content-Type"])
                        headers["Content-Type"] = "application/octet-stream";
                    afterHeaders();
                });
            }
            else {
                afterHeaders();
            }

            function afterHeaders() {
                _self.httpResponse.writeHead(200, headers);
                _self.httpResponse.end();
            }
        });
    };

    /**
     * HTTP Delete
     *
     * The HTTP delete method, deletes a given uri
     *
     * @return {void}
     * @throws {Error}
     */
    this.httpDelete = function() {
        var uri   = this.getRequestUri(),
            _self = this;

        this.tree.getNodeForPath(uri, function(err, node) {
            if (!Util.empty(err))
                return _self.handleError(err);

            if (_self.emit("beforeUnbind", uri))
                return;
            node["delete"](function(err) {
                if (!Util.empty(err))
                    return _self.handleError(err);
                _self.httpResponse.writeHead(204, {"Content-Length": "0"});
                _self.httpResponse.end();
            });
        });
    };

    /**
     * WebDAV PROPFIND
     *
     * This WebDAV method requests information about an uri resource, or a list
     * of resources
     * If a client wants to receive the properties for a single resource it will
     * add an HTTP Depth: header with a 0 value.
     * If the value is 1, it means that it also expects a list of sub-resources
     * (e.g.: files in a directory)
     *
     * The request body contains an XML data structure that has a list of
     * properties the client understands.
     * The response body is also an xml document, containing information about
     * every uri resource and the requested properties
     *
     * It has to return a HTTP 207 Multi-status status code
     *
     * @throws {Error}
     */
    this.httpPropfind = function() {
        var _self = this,
            req   = this.httpRequest,
            data  = "";
        req.setEncoding("utf8");
        req.addListener("data", function(chunk) {
            data += chunk;
        });
        req.addListener("end",  function() {
            if (jsDAV.debugMode)
                Sys.puts("INFO: data received " + data);
            _self.parsePropfindRequest(data, function(err, requestedProperties) {
                if (!Util.empty(err))
                    return _self.handleError(err);
                var depth = _self.getHTTPDepth(1);
                // The only two options for the depth of a propfind is 0 or 1
                if (depth !== 0)
                    depth = 1;

                // The requested path
                try {
                    var path = _self.getRequestUri();
                }
                catch (ex) {
                    return _self.handleError(ex);
                }
                if (jsDAV.debugMode)
                    Sys.puts("DEBUG: httpPropfind BEFORE getPropertiesForPath '" + path + "'; " + Sys.inspect(requestedProperties));
                _self.getPropertiesForPath(path, requestedProperties, depth, function(err, newProperties) {
                    if (!Util.empty(err))
                        return _self.handleError(err);
                    // This is a multi-status response
                    _self.httpResponse.writeHead(207, {"Content-Type": "application/xml; charset=utf-8"});
                    _self.httpResponse.end(_self.generateMultiStatus(newProperties));
                });
            });
        });
    };

    /**
     * WebDAV PROPPATCH
     *
     * This method is called to update properties on a Node. The request is an
     * XML body with all the mutations.
     * In this XML body it is specified which properties should be set/updated
     * and/or deleted
     *
     * @return {void}
     */
    this.httpProppatch = function() {
        var _self = this,
            req   = this.httpRequest,
            data  = "";
        req.setEncoding("utf8");
        req.addListener("data", function(chunk) {
            data += chunk;
        });
        req.addListener("end",  function() {
            if (jsDAV.debugMode)
                Sys.puts("INFO: data received " + data);
            _self.parseProppatchRequest(data, function(err, newProperties) {
                if (!Util.empty(err))
                    return _self.handleError(err);
                var uri    = _self.getRequestUri(),
                    result = _self.updateProperties(uri, newProperties);

                _self.httpResponse.writeHead(207, {"Content-Type": "application/xml; charset=utf-8"});
                _self.httpResponse.end(_self.generateMultiStatus(result));
            });
        });
    };

    /**
     * HTTP PUT method
     *
     * This HTTP method updates a file, or creates a new one.
     * If a new resource was created, a 201 Created status code should be returned.
     * If an existing resource is updated, it's a 200 Ok
     *
     * @return {void}
     */
    this.httpPut = function() {
        var ctype,
            _self    = this,
            req      = this.httpRequest,
            isStream = (!(ctype = req.headers["content-type"]) || ctype == "application/octet-stream");
            cleanup  = function() {};

        var uri = this.getRequestUri();

        if (isStream) {
            req.setEncoding("binary");
            var file   = this.tmpDir + "/" + Util.uuid(),
                stream = new Fs.WriteStream(file);

            req.addListener("data", function(data) {
                stream.write(data, "binary");
            });

            req.addListener("end", function() {
                stream.end();
                cleanup = function() {
                    Fs.unlink(file);
                };
            });

            stream.addListener("close", function() {
                Fs.readFile(file, afterGetFile);
            });
        }
        else {
            var formidable = require("./../../vendor/formidable/lib/formidable"),
                form       = new formidable.IncomingForm();
            form.uploadDir = this.tmpDir;

            form.addListener("file", function(field, file) {
                cleanup = function() {
                    Fs.unlink(file.path);
                };
                Fs.readFile(file.path, afterGetFile);
            });

            form.addListener("error", function(err) {
                afterGetFile(err);
            });

            form.parse(req);
        }


        function afterGetFile(err, body) {
            if (!Util.empty(err))
                return _self.handleError(err);

            if (jsDAV.debugMode)
                Sys.puts("Received file " + body);

            // First we'll do a check to see if the resource already exists
            _self.tree.getNodeForPath(uri, function(err, node) {
                if (!Util.empty(err)) {
                    if (err instanceof Exc.jsDAV_Exception_FileNotFound) {
                        // If we got here, the resource didn't exist yet.
                        _self.createFile(uri, body, function() {
                            cleanup();
                            _self.httpResponse.writeHead(201, {"Content-Length": "0"});
                            _self.httpResponse.end();
                        });
                    }
                    else {
                        cleanup();
                        return _self.handleError(err);
                    }
                }
                else {
                    // Checking If-None-Match and related headers.
                    _self.checkPreconditions(false, function(err, redirected) {
                        if (!Util.empty(err)) {
                            cleanup();
                            return _self.handleError(err);
                        }
                        if (redirected) {
                            cleanup();
                            return false;
                        }
                        // If the node is a collection, we'll deny it
                        if (!node.hasFeature(jsDAV.__IFILE__)) {
                            cleanup();
                            return _self.handleError(new Exc.jsDAV_Exception_Conflict("PUT is not allowed on non-files."));
                        }
                        if (_self.emit("beforeWriteContent", uri)) {
                            cleanup();
                            return false;
                        }

                        node.put(body, function(err) {
                            cleanup();
                            if (!Util.empty(err))
                                return _self.handleError(err);
                            _self.httpResponse.writeHead(200, {"Content-Length": "0"});
                            _self.httpResponse.end();
                        });
                    });
                }
            });
        }
    };

    /**
     * WebDAV MKCOL
     *
     * The MKCOL method is used to create a new collection (directory) on the server
     *
     * @return {void}
     */
    this.httpMkcol = function() {
        var resourceType,
            properties  = {},
            _self       = this,
            req         = this.httpRequest,
            requestBody = "";
        req.setEncoding("utf8"); //@todo what about streams?
        req.addListener("data", function(chunk) {
            requestBody += chunk;
        });
        req.addListener("end",  function() {
            if (requestBody) {
                var contentType = req.headers["content-type"];
                if (contentType.indexOf("application/xml") !== 0 && contentType.indexOf("text/xml") !== 0) {
                    // We must throw 415 for unsupport mkcol bodies
                    return _self.handleError(new Exc.jsDAV_Exception_UnsupportedMediaType(
                        "The request body for the MKCOL request must have an xml Content-Type"));
                }

                Util.loadDOMDocument(requestBody, function(err, dom) {
                    var firstChild = dom.getFirstChild();
                    if (Util.toClarkNotation(firstChild) !== "{DAV:}mkcol") {
                        // We must throw 415 for unsupport mkcol bodies
                        return _self.handleError(new Exc.jsDAV_Exception_UnsupportedMediaType(
                            "The request body for the MKCOL request must be a {DAV:}mkcol request construct."));
                    }

                    var childNode;
                    for (childNode in firstChild) {
                        if (Util.toClarkNotation(childNode) !== "{DAV:}set") continue;
                        properties = Util.extend(properties, Util.parseProperties(childNode, _self.propertyMap));
                    }
                    if (!properties["{DAV:}resourcetype"]) {
                        return _self.handleError(new Exc.jsDAV_Exception_BadRequest(
                            "The mkcol request must include a {DAV:}resourcetype property")
                        );
                    }

                    delete properties["{DAV:}resourcetype"];

                    resourceType = [];
                    // Need to parse out all the resourcetypes
                    var rtNode = firstChild.getElementsByTagNameNS("urn:DAV", "resourcetype")[0];
                    for (childNode in rtNode) {
                        if (!(childNode instanceof Util.Element)) continue;
                        resourceType.push(Util.toClarkNotation(childNode));
                    }

                    afterParse();
                });
            }
            else {
                resourceType = ["{DAV:}collection"];
                afterParse();
            }

            function afterParse() {
                try {
                    var uri = _self.getRequestUri()
                }
                catch (ex) {
                    return _self.handleError(ex);
                }
                _self.createCollection(uri, resourceType, properties, function(err, result) {
                    if (!Util.empty(err))
                        return _self.handleError(err);
                    if (result && result.length) {
                        _self.httpResponse.writeHead(207, {"Content-Type": "application/xml; charset=utf-8"});
                        _self.httpResponse.end(_self.generateMultiStatus(result));
                    }
                    else {
                        _self.httpResponse.writeHead(201, {"Content-Length": "0"});
                        _self.httpResponse.end();
                    }
                });
            }
        });
    };

    /**
     * WebDAV HTTP MOVE method
     *
     * This method moves one uri to a different uri. A lot of the actual request
     * processing is done in getCopyMoveInfo
     *
     * @return {void}
     */
    this.httpMove = function() {
        var _self = this;

        this.getCopyAndMoveInfo(function(err, moveInfo) {
            if (!Util.empty(err))
                return _self.handleError(err);
            if (moveInfo["destinationExists"]) {
                if (_self.emit("beforeUnbind", moveInfo["destination"]))
                    return false;
                moveInfo["destinationNode"]["delete"](function(err) {
                    if (!Util.empty(err))
                        return _self.handleError(err);
                    afterDelete();
                });
            }
            else {
                afterDelete();
            }

            function afterDelete() {
                if (_self.emit("beforeUnbind", moveInfo["source"])
                 || _self.emit("beforeBind",   moveInfo["destination"]))
                    return false;
                _self.tree.move(moveInfo["source"], moveInfo["destination"], function(err) {
                    if (!Util.empty(err))
                        return _self.handleError(err);
                    _self.emit("afterBind", moveInfo["destination"]);

                    // If a resource was overwritten we should send a 204, otherwise a 201
                    _self.httpResponse.writeHead(moveInfo["destinationExists"] ? 204 : 201,
                        {"Content-Length": "0"});
                    _self.httpResponse.end();
                });
            }
        });
    };

    /**
     * WebDAV HTTP COPY method
     *
     * This method copies one uri to a different uri, and works much like the MOVE request
     * A lot of the actual request processing is done in getCopyMoveInfo
     *
     * @return {void}
     */
    this.httpCopy = function() {
        var _self = this;

        this.getCopyAndMoveInfo(function(err, copyInfo) {
            if (!Util.empty(err))
                return _self.handleError(err);
            if (copyInfo["destinationExists"]) {
                if (_self.emit("beforeUnbind", copyInfo["destination"]))
                    return false;
                copyInfo["destinationNode"]["delete"](function(err) {
                    if (!Util.empty(err))
                        return _self.handleError(err);
                    afterDelete();
                });
            }
            else {
                afterDelete();
            }

            function afterDelete() {
                if (_self.emit("beforeBind", copyInfo["destination"]))
                    return false;
                _self.tree.copy(copyInfo["source"], copyInfo["destination"], function(err) {
                    if (!Util.empty(err))
                        return _self.handleError(err);
                    _self.emit("afterBind", copyInfo["destination"]);

                    // If a resource was overwritten we should send a 204, otherwise a 201
                    _self.httpResponse.writeHead(copyInfo["destinationExists"] ? 204 : 201,
                        {"Content-Length": "0"});
                    _self.httpResponse.end();
                });
            }
        });
    };

    /**
     * HTTP REPORT method implementation
     *
     * Although the REPORT method is not part of the standard WebDAV spec (it's from rfc3253)
     * It's used in a lot of extensions, so it made sense to implement it into the core.
     *
     * @return {void}
     */
    this.httpReport = function() {
        var _self = this,
            req   = this.httpRequest,
            data  = "";
        req.setEncoding("utf8");
        req.addListener("data", function(chunk) {
            data += chunk;
        });
        req.addListener("end",  function() {
            Util.loadDOMDocument(data, function(err, dom) {
                var reportName = Util.toClarkNotation(dom.getFirstChild());
                if (_self.emit("report", reportName, dom)) {
                    // If broadcastEvent returned true, it means the report was not supported
                    return _self.handleError(new Exc.jsDAV_Exception_ReportNotImplemented());
                }
            });
        });
    };

    /**
     * Returns an array with all the supported HTTP methods for a specific uri.
     *
     * @param  {String}   uri
     * @param  {Function} cbmethods Callback that is the return body of this function
     * @return {Array}
     */
    this.getAllowedMethods = function(uri, cbmethods) {
        var _self   = this,
            methods = [
                "OPTIONS",
                "GET",
                "HEAD",
                "DELETE",
                "PROPFIND",
                "PUT",
                "PROPPATCH",
                "COPY",
                "MOVE",
                "REPORT"
            ];

        // The MKCOL is only allowed on an unmapped uri
        this.tree.getNodeForPath(uri, function(err, node) {
            if (!Util.empty(err))
                methods.push("MKCOL");

            // We're also checking if any of the plugins register any new methods
            for (var plugin in _self.plugins)
                methods = methods.concat(plugin.getHTTPMethods(uri));

            cbmethods(null, Util.makeUnique(methods));
        });
    };

    /**
     * Gets the uri for the request, keeping the base uri into consideration
     *
     * @return {String}
     * @throws {Error}
     */
    this.getRequestUri = function() {
        Sys.puts("INFO: url: " + this.httpRequest.url);
        return this.calculateUri(this.httpRequest.url);
    };

    /**
     * Calculates the uri for a request, making sure that the base uri is stripped out
     *
     * @param  {String} uri
     * @throws {jsDAV_Exception_Forbidden} A permission denied exception is thrown
     *         whenever there was an attempt to supply a uri outside of the base uri
     * @return {String}
     */
    this.calculateUri = function(uri) {
        if (uri.charAt(0) != "/" && uri.indexOf("://") > -1)
            uri = Url.parse(uri).pathname;

        uri = uri.replace("//", "/");

        if (uri.indexOf(this.baseUri) === 0) {
            Sys.debug("INFO: returning uri: " + Util.trim(unescape(uri.substr(this.baseUri.length)), "/"));
            return Util.trim(unescape(uri.substr(this.baseUri.length)), "/");
        }
        // A special case, if the baseUri was accessed without a trailing
        // slash, we'll accept it as well.
        else if (uri + "/" === this.baseUri) {
            Sys.debug("INFO: returning uri: EMPTY");
            return "";
        }
        else {
            throw new Exc.jsDAV_Exception_Forbidden('Requested uri (' + uri
                + ') is out of base uri (' + this.baseUri + ')');
        }
    };

    /**
     * This method checks the main HTTP preconditions.
     *
     * Currently these are:
     *   * If-Match
     *   * If-None-Match
     *   * If-Modified-Since
     *   * If-Unmodified-Since
     *
     * The method will return true if all preconditions are met
     * The method will return false, or throw an exception if preconditions
     * failed. If false is returned the operation should be aborted, and
     * the appropriate HTTP response headers are already set.
     *
     * Normally this method will throw 412 Precondition Failed for failures
     * related to If-None-Match, If-Match and If-Unmodified Since. It will
     * set the status to 304 Not Modified for If-Modified_since.
     *
     * If the handleAsGET argument is set to true, it will also return 304
     * Not Modified for failure of the If-None-Match precondition. This is the
     * desired behaviour for HTTP GET and HTTP HEAD requests.
     *
     * @param  {Boolean}  handleAsGET
     * @param  {Function} cbprecond   Callback that is the return body of this function
     * @return {void}
     */
    this.checkPreconditions = function(handleAsGET, cbprecond) {
        handleAsGET = handleAsGET || false;
        var ifMatch, ifNoneMatch, ifModifiedSince, ifUnmodifiedSince,
            node    = null,
            lastMod = null,
            etag    = null,
            _self   = this;

        try {
            var uri = this.getRequestUri()
        }
        catch (ex) {
            return cbprecond(ex);
        }

        if (ifMatch = this.httpRequest.headers["if-match"]) {
            // If-Match contains an entity tag. Only if the entity-tag
            // matches we are allowed to make the request succeed.
            // If the entity-tag is '*' we are only allowed to make the
            // request succeed if a resource exists at that url.
            this.tree.getNodeForPath(uri, function(err, n) {
                if (!Util.empty(err)) {
                    return cbprecond(new Exc.jsDAV_Exception_PreconditionFailed(
                        "An If-Match header was specified and the resource did not exist",
                        "If-Match"));
                }
                node = n;
                // Only need to check entity tags if they are not *
                if (ifMatch !== "*") {
                    // The Etag is surrounded by double-quotes, so those must be
                    // stripped.
                    ifMatch = Util.trim(ifMatch, '"');
                    etag    = node.getETag();
                    if (etag !== ifMatch) {
                         return cbprecond(new Exc.jsDAV_Exception_PreconditionFailed(
                            "An If-Match header was specified, but the ETag did not match",
                            "If-Match")
                        );
                    }
                }
                afterIfMatch();
            });
        }
        else {
            afterIfMatch();
        }

        function afterIfMatch() {
            if (ifNoneMatch = _self.httpRequest.headers["if-none-match"]) {
                // The If-None-Match header contains an etag.
                // Only if the ETag does not match the current ETag, the request will succeed
                // The header can also contain *, in which case the request
                // will only succeed if the entity does not exist at all.
                var nodeExists = true;
                if (!node) {
                    _self.tree.getNodeForPath(uri, function(err, n) {
                        if (!Util.empty(err))
                            nodeExists = false;
                        else
                            node = n;
                        if (nodeExists) {
                            // The Etag is surrounded by double-quotes, so those must be
                            // stripped.
                            ifNoneMatch = Util.trim(ifNoneMatch, '"');
                            if (ifNoneMatch === "*" || ((etag = node.getETag()) && etag === ifNoneMatch)) {
                                if (handleAsGET) {
                                    _self.httpResponse.writeHead(304);
                                    _self.httpResponse.end();
                                    cbprecond(null, true);
                                    // @todo call cbprecond() differently here?
                                }
                                else {
                                    cbprecond(new Exc.jsDAV_Exception_PreconditionFailed(
                                        "An If-None-Match header was specified, but the ETag "
                                      + "matched (or * was specified).", "If-None-Match")
                                    );
                                }
                            }
                        }
                        else {
                            afterIfNoneMatch();
                        }
                    });
                }
                else {
                    afterIfNoneMatch()
                }

                function afterIfNoneMatch() {
                    if (!ifNoneMatch && (ifModifiedSince = _self.httpRequest.headers["if-modified-since"])) {
                        // The If-Modified-Since header contains a date. We
                        // will only return the entity if it has been changed since
                        // that date. If it hasn't been changed, we return a 304
                        // header
                        // Note that this header only has to be checked if there was no
                        // If-None-Match header as per the HTTP spec.
                        var date = new Date(ifModifiedSince);

                        if (!node)
                            node = _self.tree.getNodeForPath(uri, function(err) {
                                if (!Util.empty(err))
                                    return cbprecond(err);
                                lastMod = node.getLastModified();
                                if (lastMod) {
                                    lastMod = new Date("@" + lastMod);
                                    if (lastMod <= date) {
                                        _self.httpResponse.writeHead(304);
                                        _self.httpResponse.end();
                                        cbprecond(null, true);
                                        // @todo call cbprecond() differently here?
                                    }
                                }
                                afterIfModifiedSince();
                            });
                    }
                    else {
                        afterIfModifiedSince();
                    }

                    function afterIfModifiedSince() {
                        if (ifUnmodifiedSince = _self.httpRequest.headers["if-unmodified-since"]) {
                            // The If-Unmodified-Since will allow allow the request if the
                            // entity has not changed since the specified date.
                            date = new Date(ifUnmodifiedSince);
                            if (!node) {
                                _self.tree.getNodeForPath(uri, function(err, n) {
                                    if (!Util.empty(err))
                                        return cbprecond(err);
                                    node = n;
                                    finale();
                                });
                            }
                            else {
                                finale();
                            }

                            function finale() {
                                lastMod = node.getLastModified();
                                if (lastMod) {
                                    lastMod = new Date("@" + lastMod);
                                    if (lastMod > date) {
                                        return cbprecond(Exc.jsDAV_Exception_PreconditionFailed(
                                            "An If-Unmodified-Since header was specified, but the "
                                          + "entity has been changed since the specified date.",
                                            "If-Unmodified-Since")
                                        );
                                    }
                                }
                                cbprecond(null, false);
                            }
                        }
                        else {
                            cbprecond(null, false);
                        }
                    }
                }
            }
            else {
                cbprecond(null, false);
            }
        }
    };

    /**
     * Generates a WebDAV propfind response body based on a list of nodes
     *
     * @param  {Array} fileProperties The list with nodes
     * @return {String}
     */
    this.generateMultiStatus = function(fileProperties) {
        var namespace, prefix, entry, href, response,
            xml = '<?xml version="1.0" encoding="utf-8"?><d:multistatus';

        // Adding in default namespaces
        for (namespace in this.xmlNamespaces) {
            prefix = this.xmlNamespaces[namespace];
            xml += ' xmlns:' + prefix + '="' + namespace + '"';
        }

        xml += ">";

        for (var i in fileProperties) {
            entry = fileProperties[i];
            href = entry["href"];
            //delete entry["href"];

            response = new jsDAV_Property_Response(href, entry);
            xml = response.serialize(this, xml);
        }

        return xml + "</d:multistatus>";
    };

    /**
     * Returns a list of HTTP headers for a particular resource
     *
     * The generated http headers are based on properties provided by the
     * resource. The method basically provides a simple mapping between
     * DAV property and HTTP header.
     *
     * The headers are intended to be used for HEAD and GET requests.
     *
     * @param {String} path
     */
    this.getHTTPHeaders = function(path, cbheaders) {
        var header, prop,
            propertyMap = {
                "{DAV:}getcontenttype"   : "Content-Type",
                "{DAV:}getcontentlength" : "Content-Length",
                "{DAV:}getlastmodified"  : "Last-Modified",
                "{DAV:}getetag"          : "ETag"
            },
            headers    = {};
        this.getProperties(path, ["{DAV:}getcontenttype", "{DAV:}getcontentlength",
            "{DAV:}getlastmodified", "{DAV:}getetag"],
            function(err, properties) {
                if (!Util.empty(err))
                    return cbheaders(err, headers);
                for (prop in propertyMap) {
                    header = propertyMap[prop];
                    if (properties[prop]) {
                        // GetLastModified gets special cased
                        if (properties[prop].hasFeature && properties[prop].hasFeature(jsDAV.__PROP_GETLASTMODIFIED__)) {
                            headers[header] = Util.dateFormat(properties[prop].getTime(), Util.DATE_RFC1123);
                        }
                        else
                            headers[header] = properties[prop];
                    }
                }
                cbheaders(null, headers);
            });
    };

    /**
     * Returns a list of properties for a path
     *
     * This is a simplified version getPropertiesForPath.
     * if you aren't interested in status codes, but you just
     * want to have a flat list of properties. Use this method.
     *
     * @param {String} path
     * @param {Array}  propertyNames
     */
    this.getProperties = function(path, propertyNames, cbgetprops) {
        this.getPropertiesForPath(path, propertyNames, 0, function(err, result) {
            if (!Util.empty(err))
                return cbgetprops(err);
            return cbgetprops(null, result["path"]["200"])
        });
    };

    /**
     * Returns a list of properties for a given path
     *
     * The path that should be supplied should have the baseUrl stripped out
     * The list of properties should be supplied in Clark notation. If the list
     * is empty 'allprops' is assumed.
     *
     * If a depth of 1 is requested child elements will also be returned.
     *
     * @param {String} path
     * @param {Array}  propertyNames
     * @param {Number} depth
     * @return {Array}
     */
    this.getPropertiesForPath = function(path, propertyNames, depth, cbgetpropspath) {
        propertyNames = propertyNames || [];
        depth         = depth || 0;

        if (depth != 0)
            depth = 1;

        var returnPropertyList = {},
            _self              = this;

        this.tree.getNodeForPath(path, function(err, parentNode) {
            if (!Util.empty(err))
                return cbgetpropspath(err);

            var nodes = {
                path : parentNode
            };

            if (depth == 1 && parentNode.hasFeature(jsDAV.__ICOLLECTION__)) {
                parentNode.getChildren(function(err, cNodes) {
                    if (!Util.empty(err))
                        return cbgetpropspath(err);
                    for (var i = 0, l = cNodes.length; i < l; ++i)
                        nodes[cNodes[i].path] = cNodes[i];
                    afterGetChildren(nodes);
                });
            }
            else {
                afterGetChildren(nodes);
            }


            function afterGetChildren(nodes) {
                // If the propertyNames array is empty, it means all properties are requested.
                // We shouldn't actually return everything we know though, and only return a
                // sensible list.
                var allProperties = (propertyNames.length == 0);

                function afterGetProperty(rprop, rpath, remRT, newProps, cbnext) {
                    // If we were unable to find the property, we will list it as 404.
                    if (!allProperties && newProps["200"][rprop])
                        delete newProps["404"][rprop];

                    rpath = Util.trim(rpath, "/");
                    _self.emit("afterGetProperties", [rpath, newProps]);

                    newProps["href"] = rpath;

                    // Its is a WebDAV recommendation to add a trailing slash to collectionnames.
                    // Apple's iCal also requires a trailing slash for principals (rfc 3744).
                    // Therefore we add a trailing / for any non-file. This might need adjustments
                    // if we find there are other edge cases.
                    if (rpath != "" && newProps["200"]["{DAV:}resourcetype"]
                      && newProps["200"]["{DAV:}resourcetype"].getValue() !== null)
                        newProps["href"] += "/";

                    // If the resourcetype property was manually added to the requested property list,
                    // we will remove it again.
                    if (remRT)
                        delete newProps["200"]["{DAV:}resourcetype"];

                    returnPropertyList[rpath] = newProps;
                    cbnext();
                }
                    
                Async.list(Object.keys(nodes))
                     .each(function(myPath, cbnextpfp) {
                         var node = nodes[myPath];

                         var newProperties = {
                            "200" : {},
                            "404" : {}
                         };
                         if (node.hasFeature(jsDAV.__IPROPERTIES__))
                             newProperties["200"] = node.getProperties(propertyNames);

                         if (allProperties) {
                             // Default list of propertyNames, when all properties were requested.
                             propertyNames = [
                                 "{DAV:}getlastmodified",
                                 "{DAV:}getcontentlength",
                                 "{DAV:}resourcetype",
                                 "{DAV:}quota-used-bytes",
                                 "{DAV:}quota-available-bytes",
                                 "{DAV:}getetag",
                                 "{DAV:}getcontenttype",
                             ];

                             // We need to make sure this includes any propertyname already
                             // returned from node.getProperties();
                             var keys = [];
                             for (var i in newProperties["200"])
                                 keys.push(i);
                             propertyNames = propertyNames.concat(keys);

                             // Making sure there's no double entries
                             propertyNames = Util.makeUnique(propertyNames);
                         }

                         // If the resourceType was not part of the list, we manually add it
                         // and mark it for removal. We need to know the resourcetype in order
                         // to make certain decisions about the entry.
                         // WebDAV dictates we should add a / and the end of href's for collections
                         var removeRT = false;
                         if (propertyNames.indexOf("{DAV:}resourcetype") == -1) {
                             propertyNames.push("{DAV:}resourcetype");
                             removeRT = true;
                         }

                         // next loop!
                         Async.list(propertyNames)
                              .each(function(prop, cbnextprops) {
                                  if (typeof newProperties["200"][prop] != "undefined")
                                      return cbnextprops();

                                  if (prop == "{DAV:}getlastmodified") {
                                      node.getLastModified(function(err, dt) {
                                          newProperties["200"][prop] = new jsDAV_Property_GetLastModified(dt);
                                          afterGetProperty(prop, myPath, removeRT, newProperties, cbnextprops);
                                      });
                                  }
                                  else if (prop == "{DAV:}getcontentlength") {
                                      if (node.hasFeature(jsDAV.__IFILE__)) {
                                          node.getSize(function(err, size) {
                                              newProperties["200"][prop] = parseInt(size);
                                              afterGetProperty(prop, myPath, removeRT, newProperties, cbnextprops);
                                          })
                                      }
                                      else {
                                          cbnextprops();
                                      }
                                  }
                                  else if (prop == "{DAV:}resourcetype") {
                                      newProperties["200"][prop] = new jsDAV_Property_ResourceType(
                                          node.hasFeature(jsDAV.__ICOLLECTION__)
                                              ? exports.NODE_DIRECTORY
                                              : exports.NODE_FILE);
                                      afterGetProperty(prop, myPath, removeRT, newProperties, cbnextprops);
                                  }
                                  else if (prop == "{DAV:}quota-used-bytes") {
                                      if (node.hasFeature(jsDAV.__IQUOTA__)) {
                                          node.getQuotaInfo(function(err, quotaInfoUsed) {
                                              newProperties["200"][prop] = quotaInfoUsed[0];
                                              afterGetProperty(prop, myPath, removeRT, newProperties, cbnextprops);
                                          });
                                      }
                                      else {
                                          cbnextprops();
                                      }
                                  }
                                  else if (prop == "{DAV:}quota-available-bytes") {
                                      if (node.hasFeature(jsDAV.__IQUOTA__)) {
                                          node.getQuotaInfo(function(err, quotaInfoAvail) {
                                              newProperties["200"][prop] = quotaInfoAvail[1];
                                              afterGetProperty(prop, myPath, removeRT, newProperties, cbnextprops);
                                          });
                                      }
                                      else {
                                          cbnextprops();
                                      }
                                  }
                                  else if (prop == "{DAV:}getetag") {
                                      if (node.hasFeature(jsDAV.__IFILE__)) {
                                          node.getETag(function(err, etag) {
                                              if (etag)
                                                  newProperties["200"][prop] = etag;
                                              afterGetProperty(prop, myPath, removeRT, newProperties, cbnextprops);
                                          });
                                      }
                                      else {
                                          cbnextprops();
                                      }
                                  }
                                  else if (prop == "{DAV:}getcontenttype") {
                                      if (node.hasFeature(jsDAV.__IFILE__)) {
                                          node.getContentType(function(err, ct) {
                                              if (ct)
                                                  newProperties["200"][prop] = ct;
                                              afterGetProperty(prop, myPath, removeRT, newProperties, cbnextprops);
                                          });
                                      }
                                      else {
                                          cbnextprops();
                                      }
                                  }
                                  else if (prop == "{DAV:}supported-report-set") {
                                      newProperties["200"][prop] = new jsDAV_Property_SupportedReportSet();
                                      afterGetProperty(prop, myPath, removeRT, newProperties, cbnextprops);
                                  }
                                  else {
                                      cbnextprops();
                                  }
                              })
                              .end(function(err) {
                                  cbnextpfp(err);
                              });
                     })
                     .end(function(err) {
                         if (!Util.empty(err))
                             return cbgetpropspath(err);
                         cbgetpropspath(null, returnPropertyList);
                     });
            }
        });
    };

    /**
     * Returns the HTTP range header
     *
     * This method returns null if there is no well-formed HTTP range request
     * header or array(start, end).
     *
     * The first number is the offset of the first byte in the range.
     * The second number is the offset of the last byte in the range.
     *
     * If the second offset is null, it should be treated as the offset of the
     * last byte of the entity.
     * If the first offset is null, the second offset should be used to retrieve
     * the last x bytes of the entity.
     *
     * return mixed
     */
    this.getHTTPRange = function() {
        var range = this.httpRequest.headers["range"];
        if (!range)
            return null;

        // Matching "Range: bytes=1234-5678: both numbers are optional
        var matches = range.match(/^bytes=([0-9]*)-([0-9]*)$/i);
        if (!matches || !matches.length)
            return null;

        if (matches[1] === "" && matches[2] === "")
            return null;

        return [
            matches[1] ? matches[1] : null,
            matches[2] ? matches[2] : null
        ];
    };

    /**
     * Returns the HTTP depth header
     *
     * This method returns the contents of the HTTP depth request header. If the
     * depth header was 'infinity' it will return the jsDAV_Server.DEPTH_INFINITY object
     * It is possible to supply a default depth value, which is used when the depth
     * header has invalid content, or is completely non-existant
     *
     * @param  {mixed}   default
     * @return {Number}
     */
    this.getHTTPDepth = function(def) {
        def = def || exports.DEPTH_INFINITY;
        // If its not set, we'll grab the default
        var depth = this.httpRequest.headers["depth"];
        if (!depth)
            return def;

        if (depth == "infinity")
            return exports.DEPTH_INFINITY;

        // If its an unknown value. we'll grab the default
        if (typeof depth != "number")
            return def;

        return parseInt(depth);
    };

    /**
     * This method parses the PROPFIND request and returns its information
     *
     * This will either be a list of properties, or an empty array; in which case
     * an {DAV:}allprop was requested.
     *
     * @param  {String} body
     * @return {Array}
     */
    this.parsePropfindRequest = function(body, cbpropfindreq) {
        // If the propfind body was empty, it means IE is requesting 'all' properties
        if (!body)
            return cbpropfindreq(null, []);

        var oXml = Util.loadDOMDocument(body, function(err, oXml) {
            //Sys.puts("XML " + Sys.inspect(oXml));
            if (!Util.empty(err))
                return cbpropfindreq(err);
            cbpropfindreq(null, Util.hashKeys(Util.parseProperties(oXml.propfind || oXml)));
        });
    };

    /**
     * This method parses a Proppatch request
     *
     * Proppatch changes the properties for a resource. This method
     * returns a list of properties.
     *
     * The keys in the returned array contain the property name (e.g.: {DAV:}displayname,
     * and the value contains the property value. If a property is to be removed
     * the value will be null.
     *
     * @param  {String}   body           Xml body
     * @param  {Function} cbproppatchreq Callback that is the return body of this function
     * @return {Object}   list of properties in need of updating or deletion
     */
    this.parseProppatchRequest = function(body, cbproppatchreq) {
        //We'll need to change the DAV namespace declaration to something else
        //in order to make it parsable
        var child, operation, innerProperties, propertyName, propertyValue;
        Util.loadDOMDocument(body, function(err, dom) {
            if (!Util.empty(err))
                return cbproppatchreq(err);
            var firstChild    = dom.getFirstChild(),
                newProperties = {};
            for (var child in firstChild) {
                if (!(child instanceof Element)) continue;

                operation = Util.toClarkNotation(child);
                if (operation !== "{DAV:}set" && operation !== "{DAV:}remove") continue;

                innerProperties = Util.parseProperties(child, this.propertyMap);
                for (propertyName in innerProperties) {
                    propertyValue = innerProperties[propertyName];
                    if (operation === "{DAV:}remove")
                        propertyValue = null;
                    newProperties[propertyName] = propertyValue;
                }
            }

            cbproppatchreq(null, newProperties);
        });
    };

    /**
     * This method updates a resource's properties
     *
     * The properties array must be a list of properties. Array-keys are
     * property names in clarknotation, array-values are it's values.
     * If a property must be deleted, the value should be null.
     *
     * Note that this request should either completely succeed, or
     * completely fail.
     *
     * The response is an array with statuscodes for keys, which in turn
     * contain arrays with propertynames. This response can be used
     * to generate a multistatus body.
     *
     * @param  {String}  uri
     * @param  {Object}  properties
     * @return {Object}
     */
    this.updateProperties = function(uri, properties) {
        // we'll start by grabbing the node, this will throw the appropriate
        // exceptions if it doesn't.
        var propertyName, status, props,
            node     = this.tree.getNodeForPath(uri),
            result   = {
                "200" : [],
                "403" : [],
                "424" : []
            },
            remainingProperties = properties,
            hasError = false;

        // If the node is not an instance of jsDAV_IProperties, every
        // property is 403 Forbidden
        // simply return a 405.
        if (!node.hasFeature(jsDAV.__IPROPERTIES__)) {
            hasError = true;
            for (propertyName in properties)
                result["403"][propertyName] = null;
            remainingProperties = {};
        }

        // Running through all properties to make sure none of them are protected
        if (!hasError) {
            for (propertyName in properties) {
                if (this.protectedProperties.indexOf(propertyName) > -1) {
                    result["403"][propertyName] = null;
                    delete remainingProperties[propertyName];
                    hasError = true;
                }
            }
        }

        // Only if there were no errors we may attempt to update the resource
        if (!hasError) {
            var updateResult = node.updateProperties(properties);
            remainingProperties = {};

            if (updateResult === true) {
                // success
                for (propertyName in properties)
                    result["200"][propertyName] = null;
            }
            else if (updateResult === false) {
                // The node failed to update the properties for an
                // unknown reason
                foreach (propertyName in properties)
                    result["403"][propertyName] = null;
            }
            else if (typeof updateResult == "object") {
                // The node has detailed update information
                result = updateResult;
            }
            else {
                throw new Exc.jsDAV_Exception('Invalid result from updateProperties');
            }

        }

        for (propertyName in remainingProperties) {
            // if there are remaining properties, it must mean
            // there's a dependency failure
            result["424"][propertyName] = null;
        }

        // Removing empty array values
        for (status in result) {
            props = result[status];
            if (props.length === 0)
                delete result[status];
        }
        result["href"] = uri;
        return result;
    };

    /**
     * This method is invoked by sub-systems creating a new file.
     *
     * Currently this is done by HTTP PUT and HTTP LOCK (in the Locks_Plugin).
     * It was important to get this done through a centralized function,
     * allowing plugins to intercept this using the beforeCreateFile event.
     *
     * @param {String} uri
     * @param {Buffer} data
     * @return {void}
     */
    this.createFile = function(uri, data, cbcreatefile) {
        var parts = Util.splitPath(uri),
            dir   = parts[0],
            name  = parts[1],
            _self = this;

        if (this.emit("beforeBind", uri) 
         || this.emit("beforeCreateFile", uri, data))
            return cbcreatefile();

        this.tree.getNodeForPath(dir, function(err, parent) {
            if (!Util.empty(err))
                return cbcreatefile(err);
            parent.createFile(name, data, function(err) {
                if (!Util.empty(err))
                    return cbcreatefile(err);
                _self.emit("afterBind", uri);
                cbcreatefile();
            });
        });
    };

    /**
     * This method is invoked by sub-systems creating a new directory.
     *
     * @param  {String} uri
     * @return {void}
     */
    this.createDirectory = function(uri) {
        return this.createCollection(uri, ["{DAV:}collection"], {});
    };

    /**
     * Use this method to create a new collection
     *
     * The {DAV:}resourcetype is specified using the resourceType array.
     * At the very least it must contain {DAV:}collection.
     *
     * The properties array can contain a list of additional properties.
     *
     * @param  {string} uri          The new uri
     * @param  {Array}  resourceType The resourceType(s)
     * @param  {Object} properties   A list of properties
     * @return {void}
     */
    this.createCollection = function(uri, resourceType, properties, cbcreatecoll) {
        var _self     = this,
            path      = Util.splitPath(uri),
            parentUri = path[0],
            newName   = path[1];

        // Making sure {DAV:}collection was specified as resourceType
        if (resourceType.indexOf("{DAV:}collection") == -1) {
            return cbcreatecoll(new Exc.jsDAV_Exception_InvalidResourceType(
                "The resourceType for this collection must at least include {DAV:}collection")
            );
        }

        // Making sure the parent exists
        this.tree.getNodeForPath(parentUri, function(err, parent) {
            if (!Util.empty(err))
                return cbcreatecoll(new Exc.jsDAV_Exception_Conflict("Parent node does not exist"));

            // Making sure the parent is a collection
            if (!parent.hasFeature(jsDAV.__ICOLLECTION__))
                return cbcreatecoll(new Exc.jsDAV_Exception_Conflict("Parent node is not a collection"));

            // Making sure the child does not already exist
            parent.getChild(newName, function(err, ch) {
                // If we got here.. it means there's already a node on that url,
                // and we need to throw a 405
                if (typeof ch != "undefined") {
                    return cbcreatecoll(new Exc.jsDAV_Exception_MethodNotAllowed(
                        "The resource you tried to create already exists")
                    );
                }
                if (err && err.type != "jsDAV_Exception_FileNotFound")
                    return cbcreatecoll(err);

                if (_self.emit("beforeBind", uri))
                    return cbcreatecoll();

                // There are 2 modes of operation. The standard collection
                // creates the directory, and then updates properties
                // the extended collection can create it directly.
                if (parent.hasFeature(jsDAV.__IEXTCOLLECTION__)) {
                    parent.createExtendedCollection(newName, resourceType, properties, cbcreatecoll);
                }
                else {
                    // No special resourcetypes are supported
                    if (resourceType.length > 1) {
                        return cbcreatecoll(new Exc.jsDAV_Exception_InvalidResourceType(
                            "The {DAV:}resourcetype you specified is not supported here.")
                        );
                    }
                    parent.createDirectory(newName, function(err, res) {
                        if (!Util.empty(err))
                            return cbcreatecoll(err);

                        if (properties.length > 0) {
                            _self.updateProperties(uri, properties, function(err, errorResult) {
                                if (err || !isset(errorResult["200"]))
                                    return rollback(err, errorResult);
                                cbcreatecoll();
                            });
                        }
                        else {
                            cbcreatecoll();
                        }

                        function rollback(exc, res) {
                            _self.tree.getNodeForPath(uri, function(err, node) {
                                if (_self.emit("beforeUnbind", uri))
                                    return cbcreatecoll();
                                node["delete"]();

                                // Re-throwing exception
                                cbcreatecoll(exc, err);
                            });
                        }
                    });
                }
                _self.emit("afterBind", uri);
            })
        });
    };

    /**
     * Returns information about Copy and Move requests
     *
     * This function is created to help getting information about the source and
     * the destination for the WebDAV MOVE and COPY HTTP request. It also
     * validates a lot of information and throws proper exceptions
     *
     * The returned value is an array with the following keys:
     *   * source - Source path
     *   * destination - Destination path
     *   * destinationExists - Wether or not the destination is an existing url
     *     (and should therefore be overwritten)
     *
     * @return {Object}
     */
    this.getCopyAndMoveInfo = function(cbcopymove) {
        var destinationParent, destinationNode;
        try {
            var source = this.getRequestUri();
        }
        catch (ex) {
            return cbcopymove(ex);
        }

        // Collecting the relevant HTTP headers
        if (!this.httpRequest.headers["destination"])
            return cbcopymove(new Exc.jsDAV_Exception_BadRequest("The destination header was not supplied"));
        
        try {
            var destination = this.calculateUri(this.httpRequest.headers["destination"]);
        }
        catch (ex) {
            return cbcopymove(ex);
        }
        var overwrite = this.httpRequest.headers["overwrite"];
        if (!overwrite)
            overwrite = "T";
        if (overwrite.toUpperCase() == "T") {
            overwrite = true;
        }
        else if (overwrite.toUpperCase() == "F") {
            overwrite = false;
        }
        else {
            // We need to throw a bad request exception, if the header was invalid
            return cbcopymove(new Exc.jsDAV_Exception_BadRequest(
                "The HTTP Overwrite header should be either T or F")
            );
        }

        var destinationDir = Util.splitPath(destination)[0],
            _self          = this;

        // Collection information on relevant existing nodes
        //var sourceNode = this.tree.getNodeForPath(source);
        this.tree.getNodeForPath(destinationDir, function(err, destinationParent) {
            if (!Util.empty(err)) {
                // If the destination parent node is not found, we throw a 409
                return cbcopymove(err.type == "jsDAV_Exception_FileNotFound"
                    ? new Exc.jsDAV_Exception_Conflict("The destination node is not found")
                    : err);
            }
            if (!destinationParent.hasFeature(jsDAV.__ICOLLECTION__)) {
                return cbcopymove(new Exc.jsDAV_Exception_UnsupportedMediaType(
                    "The destination node is not a collection")
                );
            }

            _self.tree.getNodeForPath(destination, function(err, destinationNode) {
                // Destination didn't exist, we're all good
                if (!Util.empty(err)) {
                     if (err.type == "jsDAV_Exception_FileNotFound")
                        destinationNode = false;
                     else
                         return cbcopymove(err);
                }
                // If this succeeded, it means the destination already exists
                // we"ll need to throw precondition failed in case overwrite is false
                if (destinationNode && !overwrite) {
                    return cbcopymove(new Exc.jsDAV_Exception_PreconditionFailed(
                        "The destination node already exists, and the overwrite header is set to false",
                        "Overwrite"));
                }

                // These are the three relevant properties we need to return
                cbcopymove(null, {
                    "source"            : source,
                    "destination"       : destination,
                    "destinationExists" : !Util.empty(destinationNode),
                    "destinationNode"   : destinationNode
                });
            });
        });
    };

    /**
     * Returns a full HTTP status message for an HTTP status code
     *
     * @param {Number} code
     * @return {string}
     */
    this.getStatusMessage = function(code) {
        code = String(code);
        return "HTTP/1.1 " + code + " " + exports.STATUS_MAP[code];
    };
}).call(Server.prototype = Http.Server.prototype);

exports.createServer = function(options, port, host) {
    port = port || exports.DEFAULT_PORT;
    host = host || exports.DEFAULT_HOST;

    var server = new Server(options);
    server.listen(port, host, function() {
        Sys.puts("jsDAV server running on '" + host + "' port " + port);
    });
    return server;
};
