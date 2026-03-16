'use strict';

import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { DockPosition } from './dock.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import Shell from 'gi://Shell';
import {
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
    if (this._enabled)
      return;

    this._enabled = true;
    this._shown = true;
    this._dwell = 0;
    this._debounceCheckSeq = null;
    this._idleCheckId = 0;
    this._trackedActors = new Map();
    this._displaySignals = [];
    this._workspaceSignals = [];

    console.log('autohide enabled');

    this._updatePressureBarrier();
    this._connectGlobalSignals();
    this._trackExistingWindows();

    this._debounceCheckHide();
    this._queueIdleCheck();
  }

  disable() {
    if (!this._enabled)
      return;

    if (this.extension._hiTimer)
      this.extension._hiTimer.cancel(this._animationSeq);

    if (this._pressureBarrier) {
      this._pressureBarrier.destroy();
      this._pressureBarrier = null;
    }

    if (this._edgeBarrier) {
      this._edgeBarrier.destroy();
      this._edgeBarrier = null;
    }

    this._disconnectGlobalSignals();
    this._untrackAllWindows();
    this._clearIdleCheck();

    this.show();
    this._enabled = false;

    console.log('autohide disabled');
  }

  _getScaleFactor() {
    return this.dock._monitor.geometry_scale;
  }

  _onMotionEvent() {
    if (this.extension.pressure_sense && !this._shown) {
      let monitor = this.dock._monitor;
      let pointer = global.get_pointer();

      if (this.extension.simulated_pointer)
        pointer = [...this.extension.simulated_pointer];

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
          (this.dock._position === DockPosition.RIGHT && dy < area && pointer[0] > monitor.x + sw - 4) ||
          (this.dock._position === DockPosition.LEFT && dy < area && pointer[0] < monitor.x + 4)
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

      if (this._dwell > dwell_count)
        this.show();
    }
  }

  _onEnterEvent() {
    if (!this.extension.pressure_sense)
      this.show();
  }

  _onLeaveEvent() {
    if (this._shown) {
      this._dwell = 0;
      this._debounceCheckHide();
      this._queueIdleCheck();
    }
  }

  _onFocusWindow() {
    this._debounceCheckHide();
    this._queueIdleCheck();
  }

  _onFullScreen() {
    this._debounceCheckHide();
    this._queueIdleCheck();
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
      15,
      100,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW
    );

    let monitorIndex = this.dock._monitorIndex !== undefined
      ? this.dock._monitorIndex
      : Main.layoutManager.primaryIndex;

    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

    if (!monitor)
      return;

    this._edgeBarrier = new Meta.Barrier({
      backend: global.backend,
      x1: monitor.x,
      y1: monitor.y + monitor.height,
      x2: monitor.x + monitor.width,
      y2: monitor.y + monitor.height,
      directions: Meta.BarrierDirection.POSITIVE_Y,
    });

    this._pressureBarrier.addBarrier(this._edgeBarrier);

    this._pressureBarrier.connect('trigger', () => {
      if (!this._shown)
        this.show();
    });
  }

  show() {
    if (!this.dock._monitor || this.dock._monitor.inFullscreen)
      return;

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

  _connectGlobalSignals() {
    this._displaySignals.push(
      global.display.connect('window-created', (_display, metaWindow) => {
        this._track(metaWindow);
        this._debounceCheckHide();
        this._queueIdleCheck();
      })
    );

    this._displaySignals.push(
      global.display.connect('restacked', () => {
        this._debounceCheckHide();
        this._queueIdleCheck();
      })
    );

    this._displaySignals.push(
      global.display.connect('notify::focus-window', () => {
        this._debounceCheckHide();
        this._queueIdleCheck();
      })
    );

    this._workspaceSignals.push(
      global.workspace_manager.connect('active-workspace-changed', () => {
        this._trackExistingWindows();
        this._debounceCheckHide();
        this._queueIdleCheck();
      })
    );

    this._displaySignals.push(
      Main.layoutManager.connect('monitors-changed', () => {
        this._updatePressureBarrier();
        this._trackExistingWindows();
        this._debounceCheckHide();
        this._queueIdleCheck();
      })
    );
  }

  _disconnectGlobalSignals() {
    if (this._displaySignals) {
      this._displaySignals.forEach(id => {
        try {
          global.display.disconnect(id);
        } catch (_) {}
      });
      this._displaySignals = [];
    }

    if (this._workspaceSignals) {
      this._workspaceSignals.forEach(id => {
        try {
          global.workspace_manager.disconnect(id);
        } catch (_) {}
      });
      this._workspaceSignals = [];
    }

    try {
      Main.layoutManager.disconnectObject?.(this);
    } catch (_) {}
  }

  _trackExistingWindows() {
    let actors = global.get_window_actors();
    let windows = actors
      .map(actor => actor.get_meta_window())
      .filter(w => !!w);

    windows.forEach(w => this._track(w));
  }

  _track(metaWindow) {
    if (!metaWindow)
      return;

    let actor = metaWindow.get_compositor_private();
    if (!actor)
      return;

    if (this._trackedActors.has(actor))
      return;

    let allocationId = actor.connect('notify::allocation', () => {
      this._debounceCheckHide();
      this._queueIdleCheck();
    });

    let visibleId = actor.connect('notify::visible', () => {
      this._debounceCheckHide();
      this._queueIdleCheck();
    });

    let destroyId = actor.connect('destroy', () => {
      this._untrack(metaWindow);
      this._debounceCheckHide();
      this._queueIdleCheck();
    });

    this._trackedActors.set(actor, {
      metaWindow,
      allocationId,
      visibleId,
      destroyId,
    });
  }

  _untrack(metaWindow) {
    if (!metaWindow)
      return;

    let actor = metaWindow.get_compositor_private();
    if (!actor)
      return;

    let signals = this._trackedActors?.get(actor);
    if (!signals)
      return;

    try {
      actor.disconnect(signals.allocationId);
    } catch (_) {}

    try {
      actor.disconnect(signals.visibleId);
    } catch (_) {}

    try {
      actor.disconnect(signals.destroyId);
    } catch (_) {}

    this._trackedActors.delete(actor);
  }

  _untrackAllWindows() {
    if (!this._trackedActors)
      return;

    for (let [actor, signals] of this._trackedActors.entries()) {
      try {
        actor.disconnect(signals.allocationId);
      } catch (_) {}

      try {
        actor.disconnect(signals.visibleId);
      } catch (_) {}

      try {
        actor.disconnect(signals.destroyId);
      } catch (_) {}
    }

    this._trackedActors.clear();
  }

  _getDockWatchRect() {
    let pos = this.dock.struts.get_transformed_position();
    let arect = [pos[0], pos[1], this.dock.struts.width, this.dock.struts.height];

    let monitor = this.dock._monitor;
    if (!monitor)
      return arect;

    if (this.dock._position === DockPosition.BOTTOM) {
      arect[3] = (monitor.y + monitor.height) - arect[1];
    } else if (this.dock._position === DockPosition.TOP) {
      let bottomEdge = arect[1] + arect[3];
      arect[1] = monitor.y;
      arect[3] = bottomEdge - monitor.y;
    } else if (this.dock._position === DockPosition.LEFT) {
      let rightEdge = arect[0] + arect[2];
      arect[0] = monitor.x;
      arect[2] = rightEdge - monitor.x;
    } else if (this.dock._position === DockPosition.RIGHT) {
      arect[2] = (monitor.x + monitor.width) - arect[0];
    }

    return arect;
  }

  _getWindowRect(metaWindow) {
    let actor = metaWindow.get_compositor_private();

    if (actor && actor.allocation) {
      let a = actor.allocation;
      let width = a.x2 - a.x1;
      let height = a.y2 - a.y1;

      if (width > 0 && height > 0)
        return [a.x1, a.y1, width, height];
    }

    let frame = metaWindow.get_frame_rect();
    return [frame.x, frame.y, frame.width, frame.height];
  }

  _listRelevantWindows() {
    let monitor = this.dock._monitor;
    if (!monitor)
      return [];

    let activeWorkspace = global.workspace_manager.get_active_workspace_index();

    return global.get_window_actors()
      .map(actor => actor.get_meta_window())
      .filter(w => !!w)
      .filter(w => w.can_close())
      .filter(w => w.get_monitor() === monitor.index)
      .filter(w => {
        let ws = w.get_workspace();
        return ws && ws.index() === activeWorkspace && w.showing_on_its_workspace();
      })
      .filter(w => handledWindowTypes.includes(w.get_window_type()));
  }

  _checkOverlap() {
    if (this.extension._inOverview)
      return false;

    let pointer = global.get_pointer();
    if (this.extension.simulated_pointer)
      pointer = [...this.extension.simulated_pointer];

    let arect = this._getDockWatchRect();

    if (!this.extension.autohide_dash)
      return false;

    if (this.dock._isWithinDash(pointer) || isInRect(arect, pointer))
      return false;

    if (!this.extension.autohide_dodge)
      return true;

    if (this.dock._monitor && this.dock._monitor.inFullscreen)
      return true;

    let windows = this._listRelevantWindows();
    let dockRect = this.dock.struts.get_transformed_position();
    dockRect.push(this.dock.struts.width);
    dockRect.push(this.dock.struts.height);

    let isOverlapped = false;

    windows.forEach(w => {
      this._track(w);

      if (isOverlapped)
        return;

      let winRect = this._getWindowRect(w);
      if (isOverlapRect(dockRect, winRect))
        isOverlapped = true;
    });

    this.windows = windows;
    return isOverlapped;
  }

  _clearIdleCheck() {
    if (this._idleCheckId) {
      GLib.source_remove(this._idleCheckId);
      this._idleCheckId = 0;
    }
  }

  _queueIdleCheck() {
    this._clearIdleCheck();

    this._idleCheckId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._idleCheckId = 0;
      this._checkHide();
      return GLib.SOURCE_REMOVE;
    });
  }

  _debounceCheckHide() {
    if (!this.extension._loTimer) {
      this._checkHide();
      return;
    }

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

  _checkHide() {
    if (!this._enabled)
      return;

    if (this._checkOverlap())
      this.hide();
    else
      this.show();
  }
};