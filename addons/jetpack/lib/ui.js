/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Open Web Apps for Firefox.
 *
 * The Initial Developer of the Original Code is The Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *    Anant Narayanan <anant@kix.in>
 *    Dan Walkowski <dwalkowski@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
const {Cc, Ci, Cm, Cu} = require("chrome");
const widgets = require("widget");
const simple = require("simple-storage");
const HTML_NS = "http://www.w3.org/1999/xhtml";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

let tmp = {};
Cu.import("resource://gre/modules/Services.jsm", tmp);
let {Services} = tmp;

/* l10n support. See https://github.com/Mardak/restartless/examples/l10nDialogs */
function getString(name, args, plural) {
    let str;

    try {
        str = getString.bundle.GetStringFromName(name);
    } catch (ex1) {
        console.log("getString ex1: " + ex1);
        try {
            str = getString.fallback.GetStringFromName(name);
        } catch (ex2) {
            console.log("getString ex2: " + ex2);
        }
    }

    if (args != null) {
        if (typeof args == "string" || args.length == null)
            args = [args];
        str = str.replace(/%s/gi, args[0]);
        Array.forEach(args, function(replacement, index) {
            str = str.replace(RegExp("%" + (index + 1) + "\\$S", "gi"), replacement);
        });
    }
    return str;
}
getString.init = function(getUrlCB, getAlternate) {
    if (typeof getAlternate != "function")
        getAlternate = function() "en-US";

    function getBundle(locale) {
        let propertyFile = getUrlCB("locale/" + locale + ".properties");
        try {
            let tmp = {};
            Cu.import("resource://gre/modules/Services.jsm", tmp);

            let uniqueFileSpec = propertyFile + "#" + Math.random();
            let bundle = tmp.Services.strings.createBundle(uniqueFileSpec);
            bundle.getSimpleEnumeration();
            return bundle;
        } catch (ex) {
            console.log("getString init: " + ex);
        }
        return null;
    }

    let locale = Cc["@mozilla.org/chrome/chrome-registry;1"].
        getService(Ci.nsIXULChromeRegistry).getSelectedLocale("global");
    getString.bundle = getBundle(locale) || getBundle(getAlternate(locale));
    getString.fallback = getBundle("en-US");
}


/**
 * dashboard
 *
 * the dashboard widget is created once during the addon startup.  addon sdk
 * handles adding the widget to each new window
 */
var dashboard = {
    init: function() {
        let tmp = {};
        tmp = require("./api");
        this._repo = tmp.FFRepoImplService;
    
        Services.obs.addObserver( this, "openwebapp-installed", false);
        Services.obs.addObserver( this, "openwebapp-uninstalled", false);

        let self = this;
        let data = require("self").data;
        let thePanel = require("panel").Panel({
            height: 130,
            width: 800,
            contentURL: data.url("panel.html"),
            contentScriptFile: [data.url("base32.js"),
                                data.url("jquery-1.4.2.min.js"),
                                data.url("panel.js") ],
            onShow: function() {
                    self._repo.list(function(apps) {
                        thePanel.port.emit("theList", apps);
                    });
            }
        });
        
        thePanel.port.on("getList", function(arg) {
            self._repo.list(function(apps) {
                thePanel.port.emit("theList", apps);
            });
        });
        
        thePanel.port.on("launch", function(arg) {
            self._repo.launch(arg);
            thePanel.hide();
        });

        this._panel = thePanel;

        this._widget = widgets.Widget({
            id: "openwebapps-toolbar-button",
            label: "Web Apps",
            width: 60,
            contentURL: require("self").data.url("widget-label.html"),
            panel: thePanel
        });
    },

    /**
     * update
     *
     * update the dashboard with any changes in the apps list
     * XXX Dashboard should just have a listener built in
     */
    update: function(show) {
        let self = this;
        self._repo.list(function(apps) {
          self._panel.port.emit("theList", apps);
        });
        let currentDoc = WM.getMostRecentWindow("navigator:browser").document;
        var widgetAnchor = currentDoc.getElementById("widget:" + 
                                              require("self").id + "-openwebapps-toolbar-button");
    
        if (show != undefined) {
          self._panel.show(widgetAnchor);
        }
      
    },
    observe: function(subject, topic, data) {
        if (topic == "openwebapp-installed") {
            try{
               dashboard.update('yes');
            } catch (e) {
                console.log(e);
            }
        } else if (topic == "openwebapp-uninstalled") {
               dashboard.update();
        }
    }    
}


function openwebappsUI(win, getUrlCB, repo)
{
    this._repo = repo;
    this._window = win;
    this._getUrlCB = getUrlCB;

    /* Setup l10n */
    getString.init(getUrlCB);
    this._overlay();
    this._setupTabHandling();

    /* Offer to install */
    this._offerAppPanel = null;
    this._installInProgress = false;
}
openwebappsUI.prototype = {
    _overlay: function() {
        // Load CSS before adding toolbar butt/on
        // XXX: Seems to cause some sort of flicker?
        let doc = this._window.document;
        let pi = doc.createProcessingInstruction(
            "xml-stylesheet", "href=\"" + this._getUrlCB("skin/overlay.css") +
            "\" type=\"text/css\""
        );
        doc.insertBefore(pi, doc.firstChild);
    },

    _setupTabHandling: function() {
        // Handle the case of our special app tab being selected so we
        // can hide the URL bar etc.
        let container = this._window.gBrowser.tabContainer;
        let ss = Cc["@mozilla.org/browser/sessionstore;1"]
                    .getService(Ci.nsISessionStore);
        let wm = Cc["@mozilla.org/appshell/window-mediator;1"]
                    .getService(Ci.nsIWindowMediator);

        function appifyTab(evt) {
            let win = wm.getMostRecentWindow("navigator:browser");
            let box = win.document.getElementById("nav-bar");

            if (ss.getTabValue(evt.target, "appURL")) {
                box.setAttribute("collapsed", true);
            } else {
                box.setAttribute("collapsed", false);
            }
        }

        container.addEventListener("TabSelect", appifyTab, false);
        // unloaders.push(container.removeEventListener("TabSelect", appifyTab,
        // false);
    },

    _hideOffer: function() {
        if (this._offerAppPanel && this._offerAppPanel.isShowing)
            this._offerAppPanel.hide();
    },

    _showPageHasApp: function(page) {
        let link = simple.storage.links[page];
        if (!link.show || this._installInProgress)
            return;
    
        if (!this._offerAppPanel) {
            this._offerAppPanel = require("panel").Panel({
                contentURL: require("self").data.url("offer.html"),
                contentScript: 'let actions = ["yes", "no", "never"];' +
                    'for (let i = 0; i < actions.length; i++) { ' +
                    '   document.getElementById(actions[i]).onclick = ' +
                    '       (function(i) { return function() { ' +
                    '           self.port.emit(actions[i]);' +
                    '       }})(i); ' +
                    '}'
            });
        }
        if (this._offerAppPanel.isShowing) return;

        /* Setup callbacks */
        let self = this;
        this._offerAppPanel.port.on("yes", function() {
            self._installInProgress = true;
            self._offerAppPanel.hide();
            self._repo.install(
                "chrome://openwebapps", {
                    _autoInstall: true,
                    url: link.url,
                    origin: page,
                    onsuccess: function() {
                        self._installInProgress = false;
                        //simple.storage.links[page].show = false;
                    }
                }, self._window
            );
        });
        this._offerAppPanel.port.on("no", function() {
            self._offerAppPanel.hide();
        });
        this._offerAppPanel.port.on("never", function() {
            self._offerAppPanel.hide();
            simple.storage.links[page].show = false;
        });

        /* Prepare to anchor panel to apps widget */
        let WM = Cc['@mozilla.org/appshell/window-mediator;1']
            .getService(Ci.nsIWindowMediator);
        let doc = WM.getMostRecentWindow("navigator:browser").document;
        let bar = doc.getElementById("widget:" + 
            require("self").id + "-openwebapps-toolbar-button");

        this._offerAppPanel.show(bar);
    }
};

exports.openwebappsUI = openwebappsUI;
exports.dashboard = dashboard;
