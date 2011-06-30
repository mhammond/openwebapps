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

// a callback to create mediator args, keyed by service ID.
var mediatorCreators = {};

/**
 We create a service invocation panel when needed; there is at most one per
 tab, but the user can switch away from a tab while a service invocation
 dialog is still in progress.


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

    _createPopupPanel: function() {
      let doc = this._window.document;
      let XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
      let xulPanel = doc.createElementNS(XUL_NS, "panel");
      xulPanel.setAttribute("type", "arrow");

      let frame = doc.createElementNS(XUL_NS, "browser");      
      frame.setAttribute("flex", "1");
      frame.setAttribute("type", "content");
      frame.setAttribute("transparent", "transparent");
      frame.setAttribute("style", "width:484px;height:484px");
      xulPanel.appendChild(frame);
      doc.getElementById("mainPopupSet").appendChild(xulPanel);
      
      return [xulPanel, frame];
    },

    registerMediator: function(methodName, callback) {
      // this is conceptually a 'static' method - once called it will affect
      // all future instances of the serviceInvocationHandler.
      mediatorCreators[methodName] = callback;
    },

    show: function(panelRecord) {
      // NOTE: it is possible a popup for another service is already showing -
      // we should check for this and hide them.
      var {panel, iframe, methodName, mediatorargs} = panelRecord;
      var url = mediatorargs && mediatorargs.url
                ? mediatorargs.url
                : require("self").data.url("service2.html");
      if (iframe.getAttribute("src") != url) {
        iframe.setAttribute("src", url)
      }
      // TODO: steal sizeToContent from F1
      if (panel.state == "closed") {
          panel.sizeTo(500, 400);
          let anchor;
          if (mediatorargs && mediatorargs.anchor)
            anchor = mediatorargs.anchor;
          if (!anchor) {
            anchor = this._window.document.getElementById('identity-box');
          }
          panel.openPopup(anchor, "after_start", 8);
          if (mediatorargs && mediatorargs.onhide) {
            let onhidden = function() {
              panel.removeEventListener("popuphidden", onhidden, false);
              mediatorargs.onhide(iframe);
            }
            panel.addEventListener("popuphidden", onhidden, false);
          }
      }
      // We re-call the onshow method even if it was previously opened
      // because the url might have changed (ie, we may be using a different
      // mediator than last time)
      if (mediatorargs && mediatorargs.onshow) {
        mediatorargs.onshow(iframe);
      }
    },

    observe: function(subject, topic, data) {
      if (topic === "openwebapp-installed" || topic === "openwebapp-uninstalled")
      {
        // let our panels know, if they are visible
        for each (let popupCheck in this._popups) {
          if (popupCheck.panel.state != "closed")
          {
            this._updateContent(popupCheck);
          }
        }
      }
    },

    // called when an app tells us it's ready to go
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

    // when an app registers a service handler
    registerServiceHandler: function(contentWindowRef, activity, message, func) {
        // check that this is indeed an app
        FFRepoImplService.getAppByUrl(contentWindowRef.location, function(app) {
            if (!app) return;

            // make sure the app supports this activity
            if (!(app.services && app.services[activity])) {
                console.log("app attempted to register handler for activity " + activity + " but not declared in manifest");
                return;
            }
            
            //console.log("Registering handler for " + app.origin + " " + activity + " / " + message);

            // do we need to unwrap it?
            var theWindow = contentWindowRef;

            if (!theWindow._MOZ_SERVICES)
                theWindow._MOZ_SERVICES = {};

            if (!theWindow._MOZ_SERVICES[activity])
                theWindow._MOZ_SERVICES[activity] = {};

            theWindow._MOZ_SERVICES[activity][message] = func;
        });
    },

    // invoke below should really be named startActivity or something
    // this call means to invoke a specific call within a given app
    invokeService: function(contentWindow, activity, message, args, cb) {
        FFRepoImplService.getAppByUrl(contentWindow.location, function(app) {
            if (!app) return;

            // make sure the app supports this activity
            if (!(app.services && app.services[activity])) {
                console.log("attempted to send message to app for activity " + activity + " but app doesn't support it");
                return;
            }

            var theWindow = contentWindow;

            try {
                theWindow._MOZ_SERVICES[activity][message](args, cb);
            } catch (e) {
                console.log("error invoking " + activity + "/" + message + " on app " + app.origin + "\n" + e.toString());
            }
        });
    },

    invoke: function(contentWindowRef, methodName, args, successCB, errorCB) {
      try {
        // Do we already have a panel for this service for this content window?
        let thePanel, theIFrame, thePanelRecord;
        for each (let popupCheck in this._popups) {
          if (contentWindowRef == popupCheck.contentWindow && methodName == popupCheck.methodName) {
            thePanel = popupCheck.panel;
            theIFrame = popupCheck.iframe;
            thePanelRecord = popupCheck;
            break;
          }
        }
        // If not, go create one
        if (!thePanel) {
          let tmp = this._createPopupPanel();
          thePanel = tmp[0];
          theIFrame = tmp[1];
          thePanelRecord =  { contentWindow: contentWindowRef, panel: thePanel, iframe: theIFrame} ;
          this._popups.push( thePanelRecord );
          // add an unload listener so we can nuke this popup info as the window closes.
          let self = this;
          contentWindowRef.addEventListener("unload", function(evt) {
            // nuke any popups targetting this window.
            // XXX - this probably needs tweaking - what if the app is still
            // "working" as the user navigates away from the page?  Currently
            // there is no reasonable way to detect this though.
            let newPopups = [];
            for each (let popupCheck in self._popups) {
              if (contentWindowRef === evt.currentTarget) {
                // this popup record must die.
                let nukePanel = popupCheck.panel;
                if (nukePanel.state !== "closed") {
                  nukePanel.hidePopup();
                }
              } else {
                newPopups.push(popupCheck);
              }
            }
            console.log("window closed - had", self._popups.length, "popups, now have", newPopups.length);
            self._popups = newPopups;
            }, false);
        }
        // Update the content for the new invocation
        let ma = mediatorCreators[methodName] ? mediatorCreators[methodName]() : undefined;
        thePanelRecord.mediatorargs = ma;
        thePanelRecord.contentWindow = contentWindowRef;
        thePanelRecord.methodName = methodName;
        thePanelRecord.args = (ma && ma.updateargs) ? ma.updateargs(args) : args;
        thePanelRecord.successCB = successCB;
        thePanelRecord.errorCB = errorCB;
        this.show(thePanelRecord);

        //XX this memory is going to stick around for a long time; consider cleaning it up proactively
        
        this._updateContent(thePanelRecord);
        } catch (e) {
          dump(e + "\n");
          dump(e.stack + "\n");
        }
    },

    _updateContent: function(thePanelRecord) {
      // We are going to inject into our iframe (which is pointed at service.html).
      // It needs to know:
      // 1. What method is being invoked (and maybe some nice explanatory text)
      // 2. Which services can provide that method, along with their icons and iframe URLs
      // 3. Where to return messages to once it gets confirmation (that would be this)

      // If there was an error we are about to destroy the context for the
      // error, so hide any notifications.
      this._hideErrorNotification(thePanelRecord);

      // Hang on, the window may not be fully loaded yet
      let self = this;
      let { methodName, args, successCB, errorCB } = thePanelRecord;
      let contentWindowRef = thePanelRecord.contentWindow;
      let theIFrame = thePanelRecord.iframe;
      let thePanel = thePanelRecord.panel;
      
      
      function updateContentWhenWindowIsReady()
      {
//        let theIFrame = theIFrame.wrappedJSObject;
        if (theIFrame.contentDocument.readyState !== "complete") {
          let timeout = self._window.setTimeout(updateContentWhenWindowIsReady, 1000);
        } else {
          // Ready to go: attach our response listener if we haven't already
          // (eg, on reconfigure events we get here twice...)
          if (!thePanelRecord.haveAddedListener) {
            theIFrame.contentDocument.wrappedJSObject.addEventListener("message", function(event) {
              if (event.origin == "resource://openwebapps/service") {
                var msg = JSON.parse(event.data);
                // first see if our mediator wants to handle or mutate this.
                let mediatorargs = thePanelRecord.mediatorargs;
                if (mediatorargs && mediatorargs.onresult) {
                  try {
                    msg = mediatorargs.onresult(msg) || {cmd: ''};
                  } catch (ex) {
                    console.error("mediator callback", msg.cmd, "failed:", ex, ex.stack);
                  }
                }
                if (msg.cmd == "result") {
                  try {
                    thePanel.hidePopup();
                    successCB(event.data);
                  } catch (e) {
                    dump(e + "\n");
                  }
                } else if (msg.cmd == "error") {
                  dump(event.data + "\n");
                  // Show the error box - it might be better to only show it
                  // if the panel is not showing, but OTOH, the panel might
                  // have been closed just as the error was being rendered
                  // in the panel - so for now we always show it.
                  self._showErrorNotification(thePanelRecord);
                } else if (msg.cmd == "reconfigure") {
                  dump("services.js: Got a reconfigure event\n");
                  self._updateContent(thePanelRecord);
                }
              } else {
              }
            }, false);
            thePanelRecord.haveAddedListener = true;
          };

          // Send an initialize event before touching the iframes etc so the
          // page can delete existing ones etc.
          theIFrame.contentWindow.wrappedJSObject.handleAdminPostMessage(
              JSON.stringify({cmd:"init", method:methodName,
                              caller:contentWindowRef.location.href}));

          thePanel.successCB = successCB;
          thePanel.errorCB = errorCB;
          
          FFRepoImplService.findServices(methodName, function(serviceList) {
    
            // Make the iframes
            for (var i=0;i<serviceList.length;i++)
            {
              let svc = serviceList[i];
              let frame = theIFrame.contentDocument.createElement("iframe");
              frame.src = svc.url;
              frame.classList.add("serviceFrame");
              frame.setAttribute("id", "svc-frame-" + i);
              theIFrame.contentDocument.getElementById("frame-garage").appendChild(frame);
              theIFrame.addEventListener("DOMContentLoaded", function(event) {
                // XXX this should be a deterministic link based on the call to registerBuiltInApp
                if (svc.url.indexOf("resource://") == 0) {
                  let observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
                  observerService.notifyObservers(frame.contentWindow, "openwebapps-service-panel-loaded", "");
                }
              }, false);
            }

            // direct call
            theIFrame.contentWindow.wrappedJSObject.handleAdminPostMessage(
                JSON.stringify({cmd:"setup", method:methodName, args:args, serviceList: serviceList, 
                                caller:contentWindowRef.location.href}));

            // direct call
            theIFrame.contentWindow.wrappedJSObject.handleAdminPostMessage(
                JSON.stringify({cmd:"start_channels"}));
          });
        }
      }
      updateContentWhenWindowIsReady();
    },

    _showErrorNotification: function(thePanelRecord) {
      let { methodName, contentWindow, mediatorargs } = thePanelRecord;
      let nId = "openwebapp-error-" + methodName;
      let nBox = this._window.gBrowser.getNotificationBox();
      let notification = nBox.getNotificationWithValue(nId);
      let message = mediatorargs.notificationErrorText || "Houston, we have app roblem";
      let self = this;
      // Check that we aren't already displaying our notification
      if (!notification) {
        buttons = [{
          label: "try again",
          accessKey: null,
          callback: function () {
            self._window.setTimeout(function () {
              self.show(thePanelRecord);
              self._updateContent(thePanelRecord);
            }, 0);
          }
        }];
        nBox.appendNotification(message, nId, null,
                                nBox.PRIORITY_WARNING_MEDIUM, buttons);
      }
    },

    _hideErrorNotification: function(thePanelRecord) {
      let { methodName } = thePanelRecord;
      let nId = "openwebapp-error-" + methodName;
      let nb = this._window.gBrowser.getNotificationBox();
      let notification = nb.getNotificationWithValue(nId);
      if (notification) {
        nb.removeNotification(notification);
      }
    }
};

var EXPORTED_SYMBOLS = ["serviceInvocationHandler"];
exports.serviceInvocationHandler = serviceInvocationHandler;
