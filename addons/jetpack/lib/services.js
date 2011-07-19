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
 *  Michael Hanson <mhanson@mozilla.com>
 *	Anant Narayanan <anant@kix.in>
 *	Mark Hammond <mhammond@mozilla.com>
 *	Shane Caraveo <scaraveo@mozilla.com>
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

const {Cu, Ci, Cc} = require("chrome"); 
var {FFRepoImplService} = require("api");
let {URLParse} = require("openwebapps/urlmatch");

// a mediator is what provides the UI for a service.  It is normal "untrusted"
// content (although from the user's POV it is somewhat trusted)
// What isn't clear is how the mediator should be registered - possibly it
// should become a normal app?
// key is the service name, value is object with static properties.
var mediators = {};

// An 'agent' is trusted code running with chrome privs.  It gets a chance to
// hook into most aspects of a service operation to add additional value for
// the user.  This might include things like automatically bookmarking
// sites which have been shared etc.  Agents will be either builtin to
// the User-Agent (ie, into Firefox) or be extensions.
var agentCreators = {}; // key is service name, value is a callable.

/**
 * MediatorPanel
 *
 * This class controls the mediator panel UI.  There is one per tab
 * per mediator, created only when needed.
 */
function MediatorPanel(window, contentWindowRef, methodName, args, successCB, errorCB) {
    this.window = window; // the window the panel is attached to
    this.contentWindow = contentWindowRef; // ???
    this.methodName = methodName;
    this.successCB = successCB;
    this.errorCB = errorCB;

    // setup our postMessage origins, may be overridden by other mediators,
    // panelOrigin SHOULD be overridden for different panels
    this.origin = "resource://openwebapps/service";
    let url = require("self").data.url("");
    this.panelOrigin = URLParse(url).normalize().originOnly().toString();

    // Update the content for the new invocation
    this.args = this.updateargs(args);
    this.mediator = mediators[this.methodName];
    this.messageListener = this._messageListener.bind(this)

    this.panel = null;
    this.browser = null;
    this.configured = false;
    this.haveAddedListener = false; // is the message handler installed?
    this.isConfigured = false;

    this._createPopupPanel();
}
MediatorPanel.prototype = {
    /* OWA Mediator Agents may subclass the following: */
    
    /**
     * Send a message into the web content.
     */
    sendMessage: function sendMessage(topic, data) {
        var messageData = JSON.stringify({
            topic: topic,
            data: data
        });
        var doc = this.browser.contentDocument;
        let win = this.browser.contentWindow;
        var msg = doc.createEvent("MessageEvent");
        msg.initMessageEvent("message", // type
                             true, true, // bubble, cancelable
                             messageData,  // data
                             this.origin, "", win); // origin, source
        doc.dispatchEvent(msg);
    },

    /**
     * what the panel gets attached to
     * */
    get anchor() { return this.window.document.getElementById('identity-box') },
    
    /**
     * update the arguments that get sent to a mediator
     */
    updateargs: function(args) {
        return args;
    },
    /**
     * handlers for show/hide of the panel
     */
    //_panelShown: function() {},
    //_panelHidden: function() {},

    /**
     * postmessage handler
     *
     * subclasses may implement a handler to intercept postmessage and
     * include their own apis
     */
    _messageListener: function(event) {
        if (event.origin != this.panelOrigin)
            return;
        var msg = JSON.parse(event.data);
        var cmd = "on_"+(msg.cmd || msg.topic);
        if (this[cmd]) {
            try {
                // XXX f1 uses topic
                this[cmd](msg.data, event);
            } catch (ex) {
                dump("ERROR: "+ex+"\n");
                console.error("Handler of MediatorPanel command", cmd, "failed:", ex, ex.stack);
            }
        } else {
            dump("MediatorPanel agent not grok this message: "+cmd+" from "+event.origin+"\n");
        }
    },
    /* end promised OWA Mediator Agent api */
    
    /* postMessage API */

    on_result: function(msg, event) {
        this.panel.hidePopup();
        // XXX why pass raw data?
        this.successCB(event.data);
    },
    
    on_error: function(msg, event) {
        this.showErrorNotification(msg);
    },
    
    on_reconfigure: function(msg, event) {
        this.updateContent();
    },
    
    /* end message api */

    _createPopupPanel: function() {
        let doc = this.window.document;
        let XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
        let panel = doc.createElementNS(XUL_NS, "panel");
        panel.setAttribute("type", "arrow");
        panel.setAttribute('level', 'parent');
        panel.setAttribute("class", "openwebapps-panel "+this.methodName.replace('.','_'));
  
        let browser = doc.createElementNS(XUL_NS, "browser");      
        browser.setAttribute("flex", "1");
        browser.setAttribute("type", "content");
        browser.setAttribute("class", "openwebapps-browser");
        browser.setAttribute("transparent", "transparent");
        panel.appendChild(browser);

        this.panel = panel;
        this.browser = browser;

        // Attach with 'useCapture = true' here since the load event doesn't
        // seem to bubble up to chrome.
        this.browserListener = this._browserLoadListener.bind(this)
        browser.addEventListener("load", this.browserListener, true);

        if (this._panelShown) {
            this.panelShown = this._panelShown.bind(this);
            panel.addEventListener('popupshown', this.panelShown,
                                false);
        }
        if (this._panelHidden) {
            this.panelHidden = this._panelHidden.bind(this);
            panel.addEventListener('popuphidden', this.panelHidden,
                                false);
        }

        doc.getElementById("mainPopupSet").appendChild(panel);
    },

    _browserLoadListener: function(event) {
        // XXX this is currently receiving load events for the panel and any
        // iframe children in the panel...how to stop?
        let self = this;
        this.window.setTimeout(function () {
            self.sizeToContent(event);
        }, 0);
        this.attachMessageListener();
    },
    
    attachMessageListener: function() {
        let win = this.browser.contentWindow;
        win.addEventListener("message", this.messageListener, false);
    },
    
    /**
     * updateContent
     *
     * This resets the service iframes for the mediator
     */
    updateContent: function() {
        // bail early if the document is not ready
        if (this.browser.contentDocument.readyState !== "complete") {
            this.window.setTimeout(this.updateContent.bind(this), 1000);
            return;
        }

        this.hideErrorNotification();

        // Send an initialize event before touching the iframes etc so the
        // page can delete existing ones etc.
        this.sendMessage('init');

        FFRepoImplService.findServices(this.methodName, function(serviceList) {
            // Make the iframes
            for (var i=0;i<serviceList.length;i++)
            {
                let svc = serviceList[i];
                let frame = this.browser.contentDocument.createElement("iframe");
                frame.src = svc.url;
                frame.classList.add("serviceFrame");
                frame.setAttribute("id", "svc-frame-" + i);
                this.browser.contentDocument.getElementById("frame-garage").appendChild(frame);
                this.browser.addEventListener("DOMContentLoaded", function(event) {
                    // XXX this should be a deterministic link based on the call to registerBuiltInApp
                    if (svc.url.indexOf("resource://") == 0) {
                        let observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
                        observerService.notifyObservers(frame.contentWindow, "openwebapps-service-panel-loaded", "");
                    }
                }, false);
            }
  
            // direct call
            this.sendMessage('setup', {
                method: this.methodName,
                args: this.args,
                serviceList: serviceList, 
                caller: this.contentWindow.location.href
            });

            // XXX this call is redundant, but would like to know what the
            // necessity of it was - mixedpuppy
            // direct call
            //this.browser.contentWindow.wrappedJSObject.handleAdminPostMessage(
            //    JSON.stringify({cmd:"start_channels"}));
        }.bind(this));
    },

    sizeToContent: function (event) {
        if (this.panel.state !== 'open') {
            // if the panel is not open and visible we will not get the correct
            // size for the panel content.  This happens when the idle observer
            // first sets src on the browser.
            return;
        }
        let doc = this.browser.contentDocument;
        let wrapper;
        if (!doc) {
            return;
        }
        if (this.mediator && this.mediator.content)
            wrapper = doc.getElementById(this.mediator.content);
        if (!wrapper)
            // try the body element
            wrapper = doc.getElementsByTagName('body')[0];
        if (!wrapper)
            // XXX old fallback
            wrapper = doc.getElementById('wrapper');
        if (!wrapper) {
            return;
        }
        this.browser.style.width = wrapper.scrollWidth + "px";
        this.browser.style.height = wrapper.scrollHeight + "px";
    },

    /**
     * show
     *
     * show the mediator popup
     */
    show: function(panelRecord) {
        let url = this.mediator && this.mediator.url;
        if (!url) {
          url = require("self").data.url("service2.html");
        }
        if (this.browser.getAttribute("src") != url) {
            this.browser.setAttribute("src", url)
        }
        if (this.panel.state == "closed") {
            // compute the correct direction of the window to ensure the panel will
            // be fully visible if possible
            let position = 'bottomcenter topleft';
            if (this.window.getComputedStyle(this.window.gNavToolbox,
                                             "").direction === "rtl") {
                position = 'bottomcenter topright';
            }
            this.panel.openPopup(this.anchor, position, 0, 0, false, false);
        }
    },

    /**
     * showErrorNotification
     *
     * show an error notification for this mediator
     */
    showErrorNotification: function(data) {
        let nId = "openwebapp-error-" + this.methodName;
        let nBox = this.window.gBrowser.getNotificationBox();
        let notification = nBox.getNotificationWithValue(nId);

        // Check that we aren't already displaying our notification
        if (!notification) {
            let message;
            if (data && data.msg)
                message = data.msg;
            else if (this.mediator && this.mediator.notificationErrorText)
                message = this.mediator.notificationErrorText;
            else
                message = "42";

            let self = this;
            buttons = [{
                label: "try again",
                accessKey: null,
                callback: function () {
                    self.window.setTimeout(function () {
                        self.show();
                    }, 0);
                }
            }];
            nBox.appendNotification(message, nId, null,
                                    nBox.PRIORITY_WARNING_MEDIUM, buttons);
        }
    },

    /**
     * hideErrorNotification
     *
     * hide notifications from this mediator
     */
    hideErrorNotification: function() {
        let nId = "openwebapp-error-" + this.methodName;
        let nb = this.window.gBrowser.getNotificationBox();
        let notification = nb.getNotificationWithValue(nId);
        if (notification) {
            nb.removeNotification(notification);
        }
    }
}


/**
 * serviceInvocationHandler
 *
 * Controller for all mediator panels within a single top level window.
 * 
 * We create a service invocation panel when needed; there is at most one per
 * tab, but the user can switch away from a tab while a service invocation
 * dialog is still in progress.
 *
 */
function serviceInvocationHandler(win)
{
    this._window = win;
    this._popups = []; // save references to popups we've created already

    let observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
    observerService.addObserver(this, "openwebapp-installed", false);
    observerService.addObserver(this, "openwebapp-uninstalled", false);
}
serviceInvocationHandler.prototype = {

    /**
     * registerMediator
     *
     * this is conceptually a 'static' method - once called it will affect
     * all future and current instances of the serviceInvocationHandler.
     *
     */
    registerMediator: function(methodName, mediator) {
      mediators[methodName] = mediator;
    },

    /**
     * registerAgent
     *
     * this is conceptually a 'static' method - once called it will affect
     * all future and current instances of the serviceInvocationHandler.
     *
     */
    registerAgent: function(methodName, callback) {
      agentCreators[methodName] = callback;
    },

    /**
     * initApp
     *
     * reset our mediators if an app is installed or uninstalled
     */
    observe: function(subject, topic, data) {
      if (topic === "openwebapp-installed" || topic === "openwebapp-uninstalled")
      {
        // All visible panels need to be reconfigured now, while invisible
        // ones can wait until they are re-shown.
        for each (let popupCheck in this._popups) {
          if (popupCheck.panel.state != "closed") {
            popupCheck.updateContent();
          } else {
            popupCheck.isConfigured = false;
          }
        }
      }
    },

    /**
     * initApp
     *
     * called when an app tells us it's ready to go
     */
    initApp: function(contentWindowRef) {
        let self = this;
        // check that this is indeed an app
        FFRepoImplService.getAppByUrl(contentWindowRef.location, function(app) {
            if (!app) return;

            // at this point, all services should be registered
            
            // we invoke the login one if it's supported
            if (app.services && app.services.login) {
                // FIXME: what do we do with tons of IFRAMEs? Do they all get the login message?
                self.invokeService(contentWindowRef, 'login', 'doLogin', {'credentials' : null}, function(result) {
                    // if result is status ok, we're good
                    if (result.status == 'ok') {
                        console.log("app is logged in");
                        return;
                    }

                    // if result is status dialog, we need to open a popup.
                    if (result.status == 'notloggedin') {
                        if (app.services.login.dialog) {
                            // open up a dialog
                            var windows = require("windows").browserWindows;
                            windows.open({
                                url: app.login_dialog_url,
                                onOpen: function(window) {
                            }});
                        }
                    }
                });
            }
        });
    },


    // FIXME: This should all be replaced with postMessage passing.
    // Until we get that working we are invoking functions directly.
    
    // when an app registers a service handler
    registerServiceHandler: function(contentWindowRef, activity, message, func) {
        // check that this is indeed an app
        FFRepoImplService.getAppByUrl(contentWindowRef.location, function(app) {

            // do we need to unwrap it?
            var theWindow = contentWindowRef;

            if (!app) {
              // We register handlers for things that aren't apps
              var theWindow = contentWindowRef;
              if (!theWindow._MOZ_NOAPP_SERVICES)
                  theWindow._MOZ_NOAPP_SERVICES = {};
              if (!theWindow._MOZ_NOAPP_SERVICES[activity])
                  theWindow._MOZ_NOAPP_SERVICES[activity] = {};
              theWindow._MOZ_NOAPP_SERVICES[activity][message] = func;
              return;
            }

            // make sure the app supports this activity
            if (!(app.services && app.services[activity])) {
                console.log("app attempted to register handler for activity " + activity + " but not declared in manifest");
                return;
            }
            //console.log("Registering handler for " + app.origin + " " + activity + " / " + message);

            if (!theWindow._MOZ_SERVICES)
                theWindow._MOZ_SERVICES = {};

            if (!theWindow._MOZ_SERVICES[activity])
                theWindow._MOZ_SERVICES[activity] = {};

            theWindow._MOZ_SERVICES[activity][message] = func;
        });
    },

    // invoke below should really be named startActivity or something
    // this call means to invoke a specific call within a given app
    invokeService: function(contentWindow, activity, message, args, cb, privileged) {
        FFRepoImplService.getAppByUrl(contentWindow.location, function(app) {
            var theWindow = contentWindow;

            if (!app) {
              if (privileged) {
                try {
                    theWindow._MOZ_NOAPP_SERVICES[activity][message](args, cb);
                } catch (e) {
                    console.log("error invoking " + activity + "/" + message + " in privileged invocation\n" + e.toString());
                }
              }
              return;
            }

            // make sure the app supports this activity
            if (!(app.services && app.services[activity])) {
                console.log("attempted to send message to app for activity " + activity + " but app doesn't support it");
                return;
            }

            try {
                theWindow._MOZ_SERVICES[activity][message](args, cb);
            } catch (e) {
                console.log("error invoking " + activity + "/" + message + " on app " + app.origin + "\n" + e.toString());
            }
        });
    },
    
    /**
     * removePanelsForWindow
     *
     * window unload handler that removes any popup panels attached to the
     * window from our list of managed panels
     */
    removePanelsForWindow: function(evt) {
        // this window is unloading
        // nuke any popups targetting this window.
        // XXX - this probably needs tweaking - what if the app is still
        // "working" as the user navigates away from the page?  Currently
        // there is no reasonable way to detect this though.
        let newPopups = [];
        for each (let popupCheck in this._popups) {
          if (popupCheck.contentWindow === evt.currentTarget) {
            // this popup record must die.
            let nukePanel = popupCheck.panel;
            if (nukePanel.state !== "closed") {
              nukePanel.hidePopup();
            }
          } else {
            newPopups.push(popupCheck);
          }
        }
        console.log("window closed - had", this._popups.length, "popups, now have", newPopups.length);
        this._popups = newPopups;
    },

    /**
     * invoke
     *
     * show the panel for a mediator, creating one if necessary.
     */
    invoke: function(contentWindowRef, methodName, args, successCB, errorCB) {
        // Do we already have a panel for this service for this content window?
        let panel;
        for each (let popupCheck in this._popups) {
          if (contentWindowRef == popupCheck.contentWindow && methodName == popupCheck.methodName) {
            panel = popupCheck;
            break;
          }
        }
        // If not, go create one
        if (!panel) {
            let agent = agentCreators[methodName] ? agentCreators[methodName] : MediatorPanel;
            panel = new agent(this._window, contentWindowRef, methodName, args, successCB, errorCB);

            this._popups.push( panel );
            // add an unload listener so we can nuke this popup info as the window closes.
            contentWindowRef.addEventListener("unload",
                               this.removePanelsForWindow.bind(this), true);
        }
        panel.show();
        //XX this memory is going to stick around for a long time; consider cleaning it up proactively
    }
};

var EXPORTED_SYMBOLS = ["serviceInvocationHandler"];
exports.serviceInvocationHandler = serviceInvocationHandler;
exports.MediatorPanel = MediatorPanel;
