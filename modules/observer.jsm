
/*
    Copyright 2007-2013 Kim A. Brandt <kimabrandt@gmx.de>

    This file is part of yarip.

    Yarip is free software; you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 3 of the License, or
    (at your option) any later version.

    Yarip is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with yarip.  If not, see <http://www.gnu.org/licenses/>.
*/

const EXPORTED_SYMBOLS = ["YaripObserver"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
const yarip = Cu.import("resource://yarip/yarip.jsm", null).wrappedJSObject;
Cu.import("resource://yarip/constants.jsm");
Cu.import("resource://yarip/uri.jsm");
Cu.import("resource://yarip/replace.jsm");
Cu.import("resource://yarip/stream.jsm");

const stringBundle = SB.createBundle("chrome://yarip/locale/observer.properties");

function YaripObserver() {
}
YaripObserver.prototype = {
    classDescription: "Yet Another Remove It Permanently - Observer",
    classID: Components.ID("{edbc2d9b-769c-45b4-9153-4559e6077ea8}"),
    contractID: "@yarip.mozdev.org/observer;1",
    _xpcom_categories: [],
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference])
}
// https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIObserver#observe%28%29
YaripObserver.prototype.observe = function(subject, topic, data) {
    switch (topic) {
        case "content-document-global-created":
            this.documentCreated(subject);
            break;
        case "http-on-modify-request":
            this.modifyRequest(subject);
            break;
        case "http-on-examine-response":
        case "http-on-examine-cached-response":
        case "http-on-examine-merged-response":
            this.examineResponse(subject);
            break;
    }
}
YaripObserver.prototype.documentCreated = function(window) {
    if (!yarip.enabled) return;

    var location = yarip.getLocation(window.document.location);
    var pageName = yarip.getFirstAddress(location.asciiHref);
    if (!pageName) return;

    var page = yarip.map.get(pageName);
    if (!page.getAllowScript()) {
        Cu.blockScriptForGlobal(window);
        yarip.logMessage(LOG_WARNING, new Error(stringBundle.formatStringFromName("WARN_BLOCK_SCRIPT2", [pageName, location.asciiHref], 2)));
    }
}
YaripObserver.prototype.modifyRequest = function(channel) {
    if (!(channel instanceof Ci.nsIHttpChannel)) return;

    channel.QueryInterface(Ci.nsIHttpChannel);

    if (!yarip.enabled) return;
    if (!yarip.schemesRegExp.test(channel.URI.scheme)) return;

    try {
        var doc = null;
        try { doc = yarip.getInterface(channel, Ci.nsIDOMWindow).document; } catch(e) {}
        if (!doc) try { doc = yarip.getInterface(channel, Ci.nsIWebNavigation).document; } catch(e) {}
        var location = yarip.getLocation(doc ? doc.location : null, channel, doc);
        if (!location) return;
        if (!yarip.schemesRegExp.test(location.scheme)) return;

        var addressObj = yarip.getAddressObjByLocation(location);
        if (!addressObj.found) return;

        var defaultView = doc ? doc.defaultView : null;
        var content = yarip.getLocation(channel.URI);
        var statusObj = this.shouldRedirect(addressObj, location, content, defaultView, location.isLink ? DO_LINKS : DO_CONTENTS);
        var itemObj = statusObj.itemObj;
        switch (statusObj.status) {
            case STATUS_UNKNOWN:
                if (!location.isPage) yarip.logContent(STATUS_UNKNOWN, location, content, null, itemObj);
                break;
            case STATUS_WHITELISTED:
                if (!location.isPage) yarip.logContent(STATUS_WHITELISTED, location, content, null, itemObj);
                break;
            case STATUS_BLACKLISTED:
                channel.cancel(Cr.NS_ERROR_ABORT);
                var newLog = yarip.logContent(STATUS_BLACKLISTED, location, content, null, itemObj);
                if (newLog && itemObj.ruleType !== TYPE_CONTENT_BLACKLIST) { // not blacklisted-rule
                    yarip.showLinkNotification(doc, location, content);
                }
                return;
            case STATUS_REDIRECTED:
                channel.cancel(Cr.NS_ERROR_ABORT);
                new YaripChannelReplace(channel, statusObj.newURI, function(oldChannel, newChannel) {
                        yarip.logContent(STATUS_REDIRECTED, location, yarip.getLocation(newChannel.URI), null, itemObj);
                    });
                return;
        }

        if (location.isLink) {
            if (!yarip.schemesRegExp.test(content.scheme)) return;

            var addressObj = yarip.getAddressObjByLocation(content);
            if (!addressObj.found) return;
        }

        /*
         * REQUEST HEADER
         */

        for (var pageName in addressObj.ext) {
            var extItem = addressObj.ext[pageName];
            if (!extItem.getDoHeaders()) continue;

            var page = yarip.map.get(pageName);
            var list = location.isPage ? page.pageRequestHeaderList : page.contentRequestHeaderList;
            if (list.length === 0) continue;

            for each (var item in list.obj) {
                if (!item.getRegExpObj().test(content.asciiHref)) continue;

                var headerValue = null;
                try {
                    try { headerValue = channel.getRequestHeader(item.getHeaderName()) } catch (e) {}
                    if (/^\s*function\b/.test(item.getScript())) {
                        var sandbox = new Cu.Sandbox(defaultView ? defaultView : (location.isLink ? content : location).asciiHref);
                        if (typeof headerValue === "string") {
                            sandbox.value = headerValue;
                            headerValue = Cu.evalInSandbox("(" + item.getScript() + "\n)(value);", sandbox);
                        } else {
                            headerValue = Cu.evalInSandbox("(" + item.getScript() + "\n)();", sandbox);
                        }
                    } else {
                        headerValue = item.getScript();
                    }

                    if (typeof headerValue !== "string") {
                        yarip.logMessage(LOG_WARNING, new Error(stringBundle.formatStringFromName("WARN_HEADER_NOT_A_STRING2", [pageName, item.getHeaderName()], 2)));
                        continue;
                    }

                    channel.setRequestHeader(item.getHeaderName(), headerValue, item.getMerge());

                    if (extItem.isSelf()) {
                        item.incrementLastFound();
                    }

                    if (defaultView) defaultView.yaripStatus = "found";
                } catch (e) {
                    yarip.logMessage(LOG_ERROR, new Error(stringBundle.formatStringFromName("ERR_SET_HEADER2", [pageName, item.getHeaderName()], 2)));
                    yarip.logMessage(LOG_ERROR, e);
                }
            }
        }
    } catch (e) {
        yarip.logMessage(LOG_ERROR, e);
    }
}
YaripObserver.prototype.examineResponse = function(channel) {
    if (!(channel instanceof Ci.nsIHttpChannel)) return;

    channel.QueryInterface(Ci.nsIHttpChannel);

    if (!yarip.schemesRegExp.test(channel.URI.scheme)) return;

    try {
        var defaultView = null;
        var doc = null;
//        var location = null;
        try {
            defaultView = yarip.getInterface(channel, Ci.nsIDOMWindow);
            doc = defaultView.document;
//            location = yarip.getLocation(doc.location, channel, doc);
        } catch(e) {
//            location = yarip.getLocation(null, channel);
        }
        var location = yarip.getLocation(null, channel, doc);
        if (!location) return;
        if (!yarip.schemesRegExp.test(location.scheme)) return;

        var content = yarip.getLocation(channel.URI);
        yarip.updateContentType(null, location, content, channel.contentType, channel.responseStatus);

        if (!yarip.enabled) return;

        var addressObj = yarip.getAddressObjByLocation(location);
        if (!addressObj.found) return;

        /*
         * RESPONSE HEADER
         */

        for (var pageName in addressObj.ext) {
            var extItem = addressObj.ext[pageName];
            if (!extItem.getDoHeaders()) continue;

            var page = yarip.map.get(pageName);
            var list = location.isPage ? page.pageResponseHeaderList : page.contentResponseHeaderList;
            if (list.length === 0) continue;

            for each (var item in list.obj) {
                if (!item.getRegExpObj().test(content.asciiHref)) continue;

                try {
                    var headerValue = null; // object
                    try { headerValue = channel.getResponseHeader(item.getHeaderName()); } catch (e) {}
                    if (/^\s*function\b/.test(item.getScript())) {
                        var sandbox = new Cu.Sandbox(defaultView ? defaultView : location.asciiHref);
                        if (typeof headerValue === "string") {
                            sandbox.value = headerValue;
                            headerValue = Cu.evalInSandbox("(" + item.getScript() + "\n)(value);", sandbox);
                        } else {
                            headerValue = Cu.evalInSandbox("(" + item.getScript() + "\n)();", sandbox);
                        }
                    } else {
                        headerValue = item.getScript();
                    }

                    if (typeof headerValue !== "string") {
                        yarip.logMessage(LOG_WARNING, new Error(stringBundle.formatStringFromName("WARN_HEADER_NOT_A_STRING2", [pageName, item.getHeaderName()], 2)));
                        continue;
                    }

                    channel.setResponseHeader(item.getHeaderName(), headerValue, item.getMerge());

                    if (extItem.isSelf()) {
                        item.incrementLastFound();
                    }
                } catch (e) {
                    yarip.logMessage(LOG_ERROR, new Error(stringBundle.formatStringFromName("ERR_SET_HEADER2", [pageName, item.getHeaderName()], 2)));
                    yarip.logMessage(LOG_ERROR, e);
                }
            }
        }

        /*
         * LOCATION HEADER REDIRECT
         */

        var isRedirect = [300, 301, 302, 303, 305, 307].indexOf(channel.responseStatus) > -1;
        if (isRedirect && (!location.isLink || yarip.privateBrowsing)) {
            var locationHeader = undefined;
            try {
                locationHeader = channel.getResponseHeader("Location");
                locationHeader = locationHeader.replace(/^\s+|\s+$/g, "").match(URL_RE)[0];
                var newURI = IOS.newURI(locationHeader, content.originCharset, null);
                var newContent = yarip.getLocation(newURI);
                var statusObj = this.shouldRedirect(addressObj, location, newContent, defaultView, DO_LINKS);
                var itemObj = statusObj.itemObj;
                switch (statusObj.status) {
                    case STATUS_UNKNOWN:
                        yarip.logContent(STATUS_UNKNOWN, location, newContent, null, itemObj);
                        break;
                    case STATUS_WHITELISTED:
                        yarip.logContent(STATUS_WHITELISTED, location, newContent, null, itemObj);
                        break;
                    case STATUS_BLACKLISTED:
                        // prevent caching
                        channel.setResponseHeader("Pragma", "no-cache", true);
                        channel.setResponseHeader("Cache-Control", "no-cache, no-store, must-revalidate", true);
                        channel.setResponseHeader("Expires", "0", true);
                        channel.cancel(Cr.NS_ERROR_ABORT);
                        var newLog = yarip.logContent(STATUS_BLACKLISTED, location, newContent, null, itemObj);
                        if (newLog && itemObj.ruleType !== TYPE_CONTENT_BLACKLIST) { // new log and not content-blacklist-rule
                            yarip.showLinkNotification(doc, location, newContent);
                        }
                        return;
                    case STATUS_REDIRECTED:
                        channel.setResponseHeader("Location", statusObj.newURI.spec, false);
                        yarip.logContent(STATUS_REDIRECTED, location, yarip.getLocation(statusObj.newURI), null, itemObj);
                        return;
                }
            } catch (e) {
                if (locationHeader !== undefined) {
                    yarip.logMessage(LOG_WARNING, new Error(stringBundle.formatStringFromName("WARN_REDIRECT_NOT_A_URL2", [content.asciiHref, locationHeader], 2)));
                } else {
                    yarip.logMessage(LOG_ERROR, e);
                }
            }
        }

        /*
         * STREAM REPLACING & PAGE SCRIPTING AND STYLING
         */

        if (!isRedirect && channel.loadFlags !== LOAD_NORMAL && /^(?:text\/.*|application\/(?:javascript|json|(?:\w+\+)?\bxml))$/.test(channel.contentType)) {
            new YaripResponseStreamListener(channel, addressObj, location, defaultView);
        }
    } catch (e) {
        yarip.logMessage(LOG_ERROR, e);
    }
}
YaripObserver.prototype.shouldRedirect = function(addressObj, location, content, defaultView, doFlag) {
    var statusObj = {
        status: STATUS_UNKNOWN,
        newURI: null
    };
    if (!addressObj.found) return statusObj;

    var url = content.asciiHref;

    for (var pageName in addressObj.ext) {
        var extItem = addressObj.ext[pageName];
        if (!extItem.getDoRedirects()) continue;

        var page = yarip.map.get(pageName);
        var list = location.isPage ? page.pageRedirectList : page.contentRedirectList;
        if (list.length === 0) continue;

        for each (var item in list.obj) {
            if (!item.getRegExpObj().test(url)) continue;

            try {
                var newSpec = null; // object
                if (/^\s*function\b/.test(item.getScript())) {
                    var sandbox = new Cu.Sandbox(defaultView ? defaultView : location.asciiHref);
                    if (/^\s*function\s*\(\s*url\s*\)/.test(item.getScript())) { // deprecated: script with asciiHref as parameter
                        yarip.logMessage(LOG_WARNING, new Error(stringBundle.formatStringFromName("WARN_SCRIPT_DEPRECATED"))); // XXX

                        sandbox.url = url;
                        newSpec = Cu.evalInSandbox("(" + item.getScript() + ")(url);", sandbox);
                    } else { // replace with function as parameter
                        sandbox.url = url;
                        sandbox.regex = item.getRegExp();
                        newSpec = Cu.evalInSandbox("url.replace(new RegExp(regex), " + item.getScript() + "\n);", sandbox);
                    }
                } else {
                    newSpec = url.replace(item.getRegExpObj(), item.getScript());
                }

                if (typeof newSpec !== "string") {
                    yarip.logMessage(LOG_WARNING, new Error(stringBundle.formatStringFromName("WARN_REDIRECT_NOT_A_STRING3", [pageName, item.getRegExp(), asciiHref], 3)));
                    continue;
                }

                // TODO Ensure newSpec is an asciiHref!
                if (newSpec !== content.asciiHref) {
                    url = newSpec;
                } else {
                    // TODO Log redirect-loop!
                    continue; // prevent redirect-loop
                }

                if (extItem.isSelf()) item.incrementLastFound();

                statusObj.itemObj = {
                    "pageName": pageName,
                    "ruleType": location.isPage ? TYPE_PAGE_REDIRECT : TYPE_CONTENT_REDIRECT,
                    "itemKey": item.getKey()
                };

                statusObj.status = STATUS_REDIRECTED;
                statusObj.newURI = IOS.newURI(newSpec, content.originCharset, null);
            } catch (e) {
                yarip.logMessage(LOG_ERROR, new Error(stringBundle.formatStringFromName("ERR_REDIRECT3", [pageName, item.getRegExp(), content.asciiHref], 3)));
                yarip.logMessage(LOG_ERROR, e);
            }
        }
    }

    if (statusObj.status === STATUS_REDIRECTED) {
        if (defaultView) defaultView.yaripStatus = "found";
        return statusObj;
    } else {
        return yarip.shouldBlacklist(addressObj, content, defaultView, doFlag);
    }
}
YaripObserver.prototype.init = function() {
    // https://developer.mozilla.org/en/docs/Observer_Notifications#Documents
    OS.addObserver(this, "content-document-global-created", true);

    //https://developer.mozilla.org/en/docs/Observer_Notifications#HTTP_requests
    OS.addObserver(this, "http-on-modify-request", false);
    OS.addObserver(this, "http-on-examine-response", false);
    OS.addObserver(this, "http-on-examine-cached-response", false);
    OS.addObserver(this, "http-on-examine-merged-response", false);
}

var wrappedJSObject = new YaripObserver();

