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
 
const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;
Cu.import("resource://openwebapps/modules/api.js");

/**
 A 'service' object as returned by createService
**/
var service = function(contentWindow, info) {
  this.contentWindow = contentWindow;
  this.origin = info.app;
  this.manifest = info.manifest;
  this.url = info.url;
  this.frameId = info.frameId;
  this.channel = null;
  // Imagine an "onLoginChange" element callback...
};

service.prototype = {
  call: function(args) {
    if (!this.channel) {
      var anIframe = this.contentWindow.document.getElementById(this.frameId);
      // Hrmph - creating the channel from this chrome code is hard :(
      // For now, we force the content itself to have a reference to
      // jschannel.js and we just steal that reference.
      // XXX - ACK - this might not be safe? :(
      var contentChannel = this.contentWindow.wrappedJSObject.Channel;
      /*  XXX - A probably much-less-safe way which also works.
      var tmp = {window: contentWindow.wrappedJSObject,
                 setTimeout: contentWindow.setTimeout};
      var loader = Cc["@mozilla.org/moz/jssubscript-loader;1"]
                 .getService(Ci.mozIJSSubScriptLoader);
      loader.loadSubScript("resource://openwebapps/chrome/content/jschannel.js", tmp);
      this.channel = Channel.build({
      XXX - end of probably less-safe way ... */
      var channel = contentChannel.build({
        window: anIframe.contentWindow,
        origin: this.url,
        scope: "openwebapps_conduit"
      });
      // now wrap the channel up so when we use on behalf of the window
      // we don't have chrome privs.
      // XXX - is this correct?
      this.channel = new XPCNativeWrapper(channel);
    };
    this.channel.call(args);
  },

  destroy: function() {
    if (this.channel) {
      this.channel.destroy();
    }
    // XXX - is this safe?  probably, as this.contentWindow is already
    // an XPCNativeWrapper...
    var anIframe = this.contentWindow.document.getElementById(this.frameId);
    if (anIframe && anIframe.parentNode) {
      anIframe.parentNode.removeChild(anIframe);
    }
  },

  // Get the closest icon that is equal to or larger than the requested size,
  // or the biggest icon below that if needed.
  getIconForSize: function(targetSize) {
    var icon;
    if (this.manifest && this.manifest.icons) {
      var bestFit = 0;
      var biggestFallback = 0;
      for (var z in this.manifest.icons) {
          var size = parseInt(z, 10);
          if (bestFit == 0 || size >= targetSize) {
            bestFit = size;
          }
          if (biggestFallback == 0 || size > biggestFallback) {
            biggestFallback = size;
          }
      }
      if (bestFit !== 0)
        icon = this.manifest.icons[bestFit];
      else if (biggestFallback !== 0)
        icon = this.manifest.icons[biggestFallback];
    }
    if (!icon) {
      icon = "default_app.png";
    } else {
      if (!(icon.indexOf("data:") == 0)) {
        icon = this.origin + icon;
      }
    }
    return icon;
  }
};

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
      
      frame.setAttribute("src", "resource://openwebapps/chrome/content/service2.html");

      return [xulPanel, frame];
    },
    
    show: function(panel) {
      // TODO: steal sizeToContent from F1
      if (panel.state == "closed") {
          panel.sizeTo(500, 400);
          let larry = this._window.document.getElementById('identity-box');
          panel.openPopup(larry, "after_start", 8);
      }
    },
    
    observe: function(subject, topic, data) {
      if (topic == "openwebapp-installed")
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
    
    invoke: function(contentWindowRef, methodName, args, successCB, errorCB) {
      try {
        // Do we already have a panel for this content window?
        let thePanel, theIFrame, thePanelRecord;
        for each (let popupCheck in this._popups) {
          if (contentWindowRef == popupCheck.contentWindow) {
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
        }
        this.show(thePanel);

        // Update the content for the new invocation        
        thePanelRecord.contentWindow = contentWindowRef;
        thePanelRecord.methodName = methodName;
        thePanelRecord.args = args;
        thePanelRecord.successCB = successCB;
        thePanelRecord.errorCB = errorCB; 
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
      
      // Hang on, the window may not be fully loaded yet
      let self = this;
      let { methodName, args, successCB, errorCB } = thePanelRecord;
      let contentWindowRef = thePanelRecord.contentWindow;
      let theIFrame = thePanelRecord.iframe;
      let thePanel = thePanelRecord.panel;
      
      
      function updateContentWhenWindowIsReady()
      {
        if (!theIFrame.contentDocument || !theIFrame.contentDocument.getElementById("wrapper")) {
          let timeout = self._window.setTimeout(updateContentWhenWindowIsReady, 1000);
        } else {
          // Ready to go...
          // Inject an additional 'createService' method into our frame's window.
          theIFrame.contentWindow.wrappedJSObject.navigator.apps.createService = function(info) {
            return new service(theIFrame.contentWindow, info);
          }
          // attach our response listener
          theIFrame.contentDocument.addEventListener("message", function(event) {
            if (event.origin == "resource://openwebapps/service") {
              var msg = JSON.parse(event.data);
              if (msg.cmd == "result") {
                try {
                  thePanel.hidePopup();
                  successCB(event.data);
                } catch (e) {
                  dump(e + "\n");
                }
              } else if (msg.cmd == "error") {
                dump(event.data + "\n");
              } else if (msg.cmd == "reconfigure") {
                dump("services.js: Got a reconfigure event\n");
                self._updateContent(contentWindowRef, thePanel, theIFrame, methodName, args, successCB, errorCB);
              }
            }
          }, false);
          
          // Send reconfigure event
          thePanel.successCB = successCB;
          thePanel.errorCB = errorCB;
          
          FFRepoImplService.findServices(methodName, function(serviceList) {
    
            // Make the iframes
            for (var i=0;i<serviceList.length;i++)
            {
              let svc = serviceList[i];
              svc.frameId = "svc-frame-" + i;
              let frame = theIFrame.contentDocument.createElement("iframe");
              frame.src = svc.url;
              frame.classList.add("serviceFrame");
              frame.setAttribute("id", svc.frameId);
              theIFrame.contentDocument.getElementById("frame-garage").appendChild(frame);
              theIFrame.addEventListener("DOMContentLoaded", function(event) {
                // XXX this should be a deterministic link based on the call to registerBuiltInApp
                if (svc.url.indexOf("resource://") == 0) {
                  let observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
                  observerService.notifyObservers(frame.contentWindow, "openwebapps-service-panel-loaded", "");
                }
              }, false);
            }
            
            theIFrame.contentWindow.postMessage(
              JSON.stringify(
                {cmd:"setup", method:methodName, args:args, serviceList: serviceList, 
                  caller:contentWindowRef.location.href}
              ), "*");
          
            theIFrame.contentWindow.postMessage(
              JSON.stringify( {cmd:"start_channels"}), "*");
              
          });
        }
      }
      updateContentWhenWindowIsReady();
    }
};

var EXPORTED_SYMBOLS = ["serviceInvocationHandler"];
