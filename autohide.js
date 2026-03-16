'use strict';

import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DockPosition } from './dock.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import Shell from 'gi://Shell';
import {
  get_distance_sqr,
  get_distance,
  isInRect,
  isOverlapRect,
} from './utils.js';

const DEBOUNCE_HIDE_TIMEOUT = 120;
const PRESSURE_SENSE_DISTANCE = 40;

const handledWindowTypes = [
  Meta.WindowType.NORMAL,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
  Meta.WindowType.UTILITY,
];

export let AutoHide = class {
  enable() {
    if (this._enabled) return;
    this._enabled = true;
    this._shown = true;
    this._dwell = 0;
    console.log('autohide enabled');
    this._updatePressureBarrier();
  }

  disable() {
    if (!this._enabled) return;
    if (this.extension._hiTimer) {
      this.extension._hiTimer.cancel(this._animationSeq);
    }
    if (this._pressureBarrier) {
      this._pressureBarrier.destroy();
      this._pressureBarrier = null;
    }
    if (this._edgeBarrier) {
      this._edgeBarrier.destroy();
      this._edgeBarrier = null;
    }

    this.show();
    this._enabled = false;

    let actors = global.get_window_actors();
    let windows = actors.map((a) => a.get_meta_window());
    windows.forEach((w) => {
      if (w._tracked) {
        this._untrack(w);
      }
    });

    console.log('autohide disabled');
  }

  _getScaleFactor() {
    return this.dock._monitor.geometry_scale;
  }

  _onMotionEvent() {
    if (this.extension.pressure_sense && !this._shown) {
      let monitor = this.dock._monitor;
      let pointer = global.get_pointer();
      if (this.extension.simulated_pointer) {
        pointer = [...this.extension.simulated_pointer];
      }

      let sw = monitor.width;
      let sh = monitor.height;
      let scale = this._getScaleFactor();
      let area = scale * (PRESSURE_SENSE_DISTANCE * PRESSURE_SENSE_DISTANCE);
      let dx = 0;
      let dy = 0;

      if (this.last_pointer) {
        dx = pointer[0] - this.last_pointer[0];
        dx = dx * dx;
        dy = pointer[1] - this.last_pointer[1];
        dy = dy * dy;
      }

      let dwell_count = 80 - 60 * (this.extension.pressure_sense_sensitivity || 0);

      if (this.dock.isVertical()) {
        if (
          (this.dock._position == DockPosition.RIGHT && dy < area && pointer[0] > monitor.x + sw - 4) ||
          (this.dock._position == DockPosition.LEFT && dy < area && pointer[0] < monitor.x + 4)
        ) {
          this._dwell++;
        } else {
          this._dwell = 0;
          this.last_pointer = pointer;
        }
      } else {
        if (dx < area && pointer[1] + 4 > monitor.y + sh) {
          this._dwell++;
        } else {
          this._dwell = 0;
          this.last_pointer = pointer;
        }
      }

      if (this._dwell > dwell_count) {
        this.show();
      }
    }
  }

  _onEnterEvent() {
    if (!this.extension.pressure_sense) {
      this.show();
    }
  }

  _onLeaveEvent() {
    if (this._shown) {
      this._dwell = 0;
      this._debounceCheckHide();
    }
  } 

  _onFocusWindow() {
    this._debounceCheckHide();
  }

  _onFullScreen() {
    this._debounceCheckHide();
  }

  _updatePressureBarrier() {
    if (this._pressureBarrier) {
      this._pressureBarrier.destroy();
      this._pressureBarrier = null;
    }
    if (this._edgeBarrier) {
      this._edgeBarrier.destroy();
      this._edgeBarrier = null;
    }

    this._pressureBarrier = new Layout.PressureBarrier(
      15, 100, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW
    );

    let monitorIndex = this.dock._monitorIndex !== undefined ? this.dock._monitorIndex : Main.layoutManager.primaryIndex;
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
    
    if (!monitor) {
        return; 
    }

    this._edgeBarrier = new Meta.Barrier({
      backend: global.backend,
      x1: monitor.x,
      y1: monitor.y + monitor.height,
      x2: monitor.x + monitor.width,
      y2: monitor.y + monitor.height,
      directions: Meta.BarrierDirection.POSITIVE_Y
    });

    this._pressureBarrier.addBarrier(this._edgeBarrier);

    this._pressureBarrier.connect('trigger', () => {
      if (!this._shown) {
        this.show();
      }
    });
  }

  show() {
    if (!this.dock._monitor || this.dock._monitor.inFullscreen) {
      return;
    }
    this._dwell = 0;
    this.frameDelay = 0;
    this._shown = true;
    this.dock.slideIn();
  }

  hide() {
    this._dwell = 0;
    this.frameDelay = 10;
    this._shown = false;
    this.dock.slideOut();
  }

  _track(window) {
    if (!window._tracked) {
      // FIX 1: Derivar los cambios de ventana al debouncer en lugar de llamada síncrona
      window.connectObject(
        'position-changed', this._debounceCheckHide.bind(this),
        'size-changed', this._debounceCheckHide.bind(this),
        this
      );
      window._tracked = true;
    }
  }

  _untrack(window) {
    try {
      if (window && window._tracked) {
        window.disconnectObject(this);
        window._tracked = false;
      }
    } catch (err) {}
  }

  _checkOverlap() {
    if (this.extension._inOverview) {
      return false;
    }
    
    let pointer = global.get_pointer();
    if (this.extension.simulated_pointer) {
      pointer = [...this.extension.simulated_pointer];
    } 

    let pos = this.dock.struts.get_transformed_position();
    let arect = [pos[0], pos[1], this.dock.struts.width, this.dock.struts.height];

    // FIX 3: Expansión geométrica incondicional. La "hitbox" del dock se estira hasta el borde real.
    let monitor = this.dock._monitor;
    if (monitor) {
      if (this.dock._position == DockPosition.BOTTOM) {
        arect[3] = (monitor.y + monitor.height) - arect[1];
      } else if (this.dock._position == DockPosition.TOP) {
        let bottomEdge = arect[1] + arect[3];
        arect[1] = monitor.y;
        arect[3] = bottomEdge - monitor.y;
      } else if (this.dock._position == DockPosition.LEFT) {
        let rightEdge = arect[0] + arect[2];
        arect[0] = monitor.x;
        arect[2] = rightEdge - monitor.x;
      } else if (this.dock._position == DockPosition.RIGHT) {
        arect[2] = (monitor.x + monitor.width) - arect[0];
      }
    }

    if (!this.extension.autohide_dash) {
      return false;
    }

    if (this.dock._isWithinDash(pointer) || isInRect(arect, pointer)) {
      return false; 
    }

    if (!this.extension.autohide_dodge) {
      return true;
    }

    if (this.dock._monitor && this.dock._monitor.inFullscreen) {
      return true;
    }

    let actors = global.get_window_actors();
    let windows = actors.map((a) => {
      let w = a.get_meta_window();
      w._parent = a;
      return w;
    });
    
    windows = windows.filter((w) => w.can_close());
    windows = windows.filter((w) => w.get_monitor() == monitor.index);
    
    let workspace = global.workspace_manager.get_active_workspace_index();
    windows = windows.filter(
      (w) => workspace == w.get_workspace().index() && w.showing_on_its_workspace()
    );
    
    // FIX 2: Reemplazado el 'in' por '.includes()'
    windows = windows.filter((w) => handledWindowTypes.includes(w.get_window_type()));

    let isOverlapped = false;
    let dockRect = this.dock.struts.get_transformed_position();
    dockRect.push(this.dock.struts.width);
    dockRect.push(this.dock.struts.height);

    // Bucle limpio sin interrupciones abruptas
    windows.forEach((w) => {
      this._track(w);
      if (!isOverlapped) {
        let frame = w.get_frame_rect();
        let win = [frame.x, frame.y, frame.width, frame.height];
        if (isOverlapRect(dockRect, win)) {
          isOverlapped = true;
        }
      }
    });

    this.windows = windows;
    return isOverlapped;
  }

  _debounceCheckHide() {
    if (this.extension._loTimer) {
      if (!this._debounceCheckSeq) {
        this._debounceCheckSeq = this.extension._loTimer.runDebounced(
          () => {
            this._checkHide();
          },
          DEBOUNCE_HIDE_TIMEOUT,
          'debounceCheckHide'
        );
      } else {
        this.extension._loTimer.runDebounced(this._debounceCheckSeq);
      }
    }
  }

  _checkHide() {
    if (this._enabled) {
      if (this._checkOverlap()) {
        this.hide();
      } else {
        this.show();
      }
    }
  }
};