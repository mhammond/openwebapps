// A module that looks and acts a bit like a Panel, but actually uses a
// Window.  Useful if you want to show a mediator in a regular Window for
// the purposes of validating (eg, using an accessibility helper)

function TempPort() {
  
}
TempPort.prototype = {
  _handlers: {},
  on: function(evt, handler) {
    if (!this._handlers[evt])
      this._handlers[evt] = [];
    this._handlers[evt].push(handler);
  },
  emit: function(evt) {
    if (evt !== 'owa.mediation.reconfigure')
      throw "this is lame - so sue me!";
  }
}

exports.Panel = function(options) {
  return new _Panel(options);
}

function _Panel(options) {
  this.options = options;
  this.port = new TempPort();
  this._tab = null;
}

_Panel.prototype = {
  _handlers: {},
  _emit: function(evt) {
    let evt_handlers = this._handlers[evt] || [];
    for each (let handler in evt_handlers) {
      handler();
    }
  },

  on: function(evt, handler) {
    if (!this._handlers[evt]) {
      this._handlers[evt] = [];
    }
    this._handlers[evt].push(handler);
  },

  show: function() {
    if (!this._tab) {
      let tabs = require("tabs");
      tabs.open({
        url: this.options.contentURL,
        onReady: function (tab) {
          this._tab = tab;
          let worker = tab.attach({
            contentScript: this.options.contentScript,
            contentScriptFile: this.options.contentScriptFile,
            contentScriptWhen: this.options.contentScriptWhen
          });
          for (let evtname in this.port._handlers) {
            for each (let handler in this.port._handlers[evtname]) {
              worker.port.on(evtname, handler);
              console.log("ON", evtname, handler)
            }
          }
          worker.port.on("owa.mediation.frame", function() {console.log("FRAMEEE");});
          this.port = worker.port;
        }.bind(this)
      });
    }
  },
/***
  hide: function() {
    if (this._tab) {
      this._tab.close();
      this._tab = null;
      this.port = new TempPort();
    }
  },
***/
  get isShowing() {
    return !!this._tab;
  },
  resize: function() {
    //console.log("panel stub is ignoring resize request");
  }
}
