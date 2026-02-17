import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import {
    State,
    GRAVITY,
    WALK_SPEED,
    isWindowMaximized,
    UPDATE_INTERVAL_MS
} from './utils.js';

/**
 * Gnomelet Class
 * Represents a single animated character on the screen.
 * Uses pre-sliced images loaded by the Manager.
 */
export const Gnomelet = GObject.registerClass(
    class Gnomelet extends GObject.Object {
        _init(typeName, frameImages, frameWidth, frameHeight, settings, resourceProvider) {
            super._init();

            this._typeName = typeName;
            this._settings = settings;
            this._resourceProvider = resourceProvider;

            // --- Animation State ---
            this._frame = 0; // Current sprite frame index
            this._animationTimer = 0; // Counter for animation timing
            this._savedFacing = Math.random() > 0.5; // Initial Direction
            this._idleTimer = 0; // Countdown for how long to stay idle

            // --- Configurable Dimensions ---
            this._frameWidth = frameWidth;
            this._frameHeight = frameHeight;

            // --- Image Resources ---
            this._frameImages = frameImages;

            // --- Actor Setup (St.Icon) ---
            let iconSize = this._updateDimensions();
            this._icon = new St.Icon({
                visible: true,
                reactive: false,
                icon_size: iconSize,
                style: 'padding: 0px; object-fit: fill;',
            });

            this.actor = new St.Widget({
                visible: true,
                reactive: false,
                layout_manager: new Clutter.BinLayout(),
            });
            this.actor.add_child(this._icon);

            if (this._frameImages.length > 0 && this._frameImages[0]) {
                this._icon.set_gicon(this._frameImages[0]);
            }

            this.actor._delegate = this;

            this._updateInteraction();
            this.updateJumpPower();

            // Only static setup above. Now call _respawn for runtime state.
            this._respawn();
        }

        // Property to define facing based on Velocity X
        get facingRight() {
            let sign = Math.sign(this._vx);
            if (sign !== 0 && !isNaN(sign)) {
                this._savedFacing = (sign > 0);
            }
            return this._savedFacing;
        }

        // Mock 'app' property to prevent crashes with gtk4-ding
        get app() {
            return null;
        }



        _updateStyle() {

            let brcolor = "#cccccc"; // Default: idle (light gray)

            if (this._isSplatted)
                brcolor = "#f30707"; // Dark gray for splatted

            let btcolor = "#cccccc"; // Default: idle (light gray)
            
            if (this._state === State.FALLING)
                btcolor = "#ff3333"; // Red
            
            if (this._state === State.WALKING)
                btcolor = "#33cc33"; // Green
            
            if (this._godMode)
                btcolor = "#6ecceb"; // Green
            
            this.actor.set_style(`border-top: 4px solid ${btcolor}; border-right: 4px solid ${brcolor};`);
        }

        /**
         * Calculates dimensions based on settings and interface scale.
         * Returns the icon_size parameter to be used for St.Icon.
         */
        _updateDimensions() {
            const settingsScale = this._settings.get_int('gnomelet-scale');
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const interfaceScale = themeContext ? themeContext.scale_factor : 1;

            // St.Icon applies the interface scale to the rendered size.
            // To ensure the visual size matches our expected logical size (settingsScale),
            // we must divide by the interface scale.
            let iconSizeParam = Math.floor(settingsScale / interfaceScale);
            if (iconSizeParam < 1) iconSizeParam = 1;

            // The actual visual height will be iconSizeParam * interfaceScale
            this._displayH = iconSizeParam * interfaceScale;

            // Update width based on aspect ratio
            this._displayW = Math.floor(this._displayH * (this._frameWidth / this._frameHeight));

            return iconSizeParam;
        }

        /**
         * Updates the gnomelet scale when settings change or interface scale changes.
         */
        updateScale() {
            let oldH = this._displayH;

            let iconSize = this._updateDimensions();

            // Update the visual size of the icon
            this._icon.set_icon_size(iconSize);

            // Adjust Y position so feet stay at the same ground level
            this._y = this._y + oldH - this._displayH;
            this.actor.set_position(this._x, this._y);
        }

        /**
         * Updates jump parameters from settings.
         */
        updateJumpPower() {
            let power = this._settings.get_int('jump-power');
            this._jumpVelocity = -Math.abs(power);
            // Re-calculate derived constants
            this._jumpReachX = (WALK_SPEED * 2) * Math.abs(this._jumpVelocity / GRAVITY);
            this._maxJumpHeight = (this._jumpVelocity * this._jumpVelocity) / (2 * GRAVITY);
        }

        /**
         * Updates the interaction mode (dragging) based on settings.
         */
        _updateInteraction() {
            let allowInteraction = this._settings.get_boolean('allow-interaction');
            let explodeOnClick = this._settings.get_boolean('explode-on-click');

            // Set reactiveness based on either drag or click behavior
            let shouldBeReactive = allowInteraction || explodeOnClick;

            if (shouldBeReactive && !this.actor.reactive) {
                this.actor.reactive = true;
            } else if (!shouldBeReactive && this.actor.reactive) {
                this.actor.reactive = false;
            }

            // If allowed and not yet draggable, make it draggable
            if (allowInteraction) {
                if (!this._draggable) {
                    this._draggable = DND.makeDraggable(this.actor);
                    this._dragBeginId = this._draggable.connect('drag-begin', this._onDragBegin.bind(this));
                    this._dragEndId = this._draggable.connect('drag-end', this._onDragEnd.bind(this));
                }
            } else {
                // Disable dragging if not allowed
                if (this._draggable) {
                    if (this._dragBeginId) this._draggable.disconnect(this._dragBeginId);
                    if (this._dragEndId) this._draggable.disconnect(this._dragEndId);
                    this._draggable = null;
                }
            }

            // Handle click events for explode-on-click
            if (explodeOnClick) {
                if (!this._clickHandlerId) {
                    // Use release so we don't trigger on press (and can ignore drags)
                    this._clickHandlerId = this.actor.connect('button-release-event', this._onClicked.bind(this));
                }
            } else {
                if (this._clickHandlerId) {
                    this.actor.disconnect(this._clickHandlerId);
                    this._clickHandlerId = null;
                }
            }
        }

        _onClicked(actor, event) {
            if (this._settings.get_boolean('explode-on-click')) {
                // Ignore if we are (or just were) dragging — do not trigger after a drag
                if (this._state === State.DRAGGING) return Clutter.EVENT_STOP;
                if (this._dragOverlay) return Clutter.EVENT_STOP;
                if (this._lastDragEndTime && (Date.now() - this._lastDragEndTime) < 300) return Clutter.EVENT_STOP;

                // Honor god-mode immortality immediately after respawn
                if (this._godMode) return Clutter.EVENT_STOP;

                this._createSplatEffect(0);
                this.actor.visible = false;

                // Respawn after a short delay
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    if (this.actor) {
                        this.actor.visible = true;
                        this._respawn();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Clutter.EVENT_STOP;
        }

        _onDragBegin() {
            this._state = State.DRAGGING;
            this._vx = 0;
            this._vy = 0;
            this._updateAnimation();
            this._dragHistory = []; // Initialize drag history for momentum calculation
            this._dropTime = 0;
            this._lastDragEndTime = 0;
            

            // Create a full-screen transparent overlay to capture the drop event
            // This prevents the shell crash caused by unhiding the source actor from pick
            this._dragOverlay = new Clutter.Actor({
                width: global.stage.width,
                height: global.stage.height,
                reactive: true
            });
            this._dragOverlay._delegate = this; // Route drag events to this Gnomelet instance
            Main.layoutManager.uiGroup.add_child(this._dragOverlay);
        }

        handleDragOver(source, actor, x, y) {
            // Track mouse history for momentum calculation
            if (!this._dragHistory) this._dragHistory = [];

            // Limit history to last ~300ms or 10 points to keep it relevant
            const now = Date.now();
            this._dragHistory.push({ x, y, time: now });

            // Prune old history
            const HISTORY_LIMIT_MS = 200;
            while (this._dragHistory.length > 0 && now - this._dragHistory[0].time > HISTORY_LIMIT_MS) {
                this._dragHistory.shift();
            }

            // We accept drag over from ourselves (or potentially others if we wanted)
            return DND.DragMotionResult.MOVE_DROP;
        }

        acceptDrop(source, actor, x, y, time) {
            // Update internal coordinates
            this._x = actor.x;
            this._y = actor.y;
            this._dropTime = time; // Capture drop time for momentum check

            // CRITICAL: Reparent to window_group to save it from dnd.js auto-destruction.
            // dnd.js attempts to destroy the drag actor if it is found in Main.uiGroup after a successful drop.
            // We temporarily move it to window_group to bypass that check.
            let parent = this.actor.get_parent();
            if (parent === Main.layoutManager.uiGroup) {
                Main.layoutManager.removeChrome(this.actor);
            } else if (parent) {
                parent.remove_child(this.actor);
            }
            global.window_group.add_child(this.actor);

            this.actor.set_position(this._x, this._y);

            return true;
        }

        _onDragEnd() {
            if (this._dragOverlay) {
                this._dragOverlay.destroy();
                this._dragOverlay = null;
            }

            // Update internal coordinates to match where the actor ended up
            this._x = this.actor.x;
            this._y = this.actor.y;

            // Reset visual transforms that might be corrupted by external DND logic
            this.actor.rotation_angle_z = 0;
            this.actor.scale_y = 1;
            this.actor.scale_x = 1; // Ensure container is not flipped
            this.actor.opacity = 255;

            // Re-apply correct facing (scale_x)
            this._icon.set_pivot_point(0.5, 0.5);
            this._icon.scale_x = this.facingRight ? 1 : -1;




            // Calculate and apply momentum from drag
            const momentum = this._calculateMomentum();
            this._vx = momentum.vx;
            this._vy = momentum.vy;

            // Now that the drag flow is complete and dnd.js is satisfied, 
            // put the actor back in the correct layer (which might be uiGroup).
            this._resetLayer();
            // mark recent drag end so click-release immediately after drag is ignored
            this._lastDragEndTime = Date.now();



            this._state = State.FALLING;
            this._fallStartY = this._y; // Reset fall tracking for potential splat
        }

        /**
         * Calculates velocity based on drag history.
         * Returns values in pixels/frame (consistent with update loop).
         */
        _calculateMomentum() {
            if (!this._dragHistory || this._dragHistory.length < 2) {
                return { vx: 0, vy: 0 };
            }

            const last = this._dragHistory[this._dragHistory.length - 1];

            // If the last drag event was too long ago (e.g. user paused before dropping), 
            // momentum should be zero.
            if (this._dropTime && (this._dropTime - last.time > 100)) {
                return { vx: 0, vy: 0 };
            }

            // Look back ~100ms for a good average, but ensure we have at least 2 points
            let prev = this._dragHistory[0];

            // Try to find a sample roughly 50-100ms ago
            for (let i = this._dragHistory.length - 2; i >= 0; i--) {
                const sample = this._dragHistory[i];
                const dt = last.time - sample.time;
                if (dt >= 50 && dt <= 150) {
                    prev = sample;
                    break;
                }
            }

            const dt = last.time - prev.time;
            if (dt <= 0) return { vx: 0, vy: 0 };

            // Calculate pixels per ms
            const vX_ms = (last.x - prev.x) / dt;
            const vY_ms = (last.y - prev.y) / dt;

            // Convert to pixels per frame (50ms)
            // Scaling factor can be tweaked for "feel". 
            // 1.0 would be mathematically correct if the update loop was perfectly timed and physics were continuous.
            // A slight boost might make it feel more "swishy".
            const SCALE_FACTOR = 0.25;

            let vx = vX_ms * UPDATE_INTERVAL_MS * SCALE_FACTOR;
            let vy = vY_ms * UPDATE_INTERVAL_MS * SCALE_FACTOR;

            // Clamp max velocity to prevent exploding offscreen
            const MAX_VELOCITY = 50;
            vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, vx));
            vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, vy));

            return { vx, vy };
        }

        /**
         * Serializes the state for persistence
         */
        serialize() {
            return {
                type: this._typeName,
                x: this._x,
                y: this._y,
                vx: this._vx,
                vy: this._vy,
                state: this._state,
                facing: this._savedFacing,
                idleTimer: this._idleTimer
            };
        }

        /**
         * Restores saved state
         */
        deserialize(data) {
            if (!data) return;


            // Handle type change if the saved state has a different gnomelet type
            if (data.type && data.type !== this._typeName && this._resourceProvider) {
                let res = this._resourceProvider(data.type);
                if (res) {
                    this._typeName = res.type;
                    this._frameImages = res.frames;
                    this._frameWidth = res.w;
                    this._frameHeight = res.h;
                    this.updateScale();
                }
            }

            if (data.x !== undefined) this._x = data.x;
            if (data.y !== undefined) this._y = data.y;
            if (data.vx !== undefined) this._vx = data.vx;
            if (data.vy !== undefined) this._vy = data.vy;
            if (data.state !== undefined) this._state = data.state;
            if (data.facing !== undefined) this._savedFacing = data.facing;
            if (data.idleTimer !== undefined) this._idleTimer = data.idleTimer;

            this.actor.set_position(this._x, this._y);
            this.setFrame(this._frame); // Refresh frame in case type changed
        }

        /**
         * Main update loop for the gnomelet.
         */
        update(windows, forceBackground, dockContainer) {
            if (!this.actor) return; // Guard against updates after destruction
            if (this._state === State.DRAGGING) {
                this._updateAnimation();
                return;
            }

            // Track fall start position (only set once per fall)
            if ((this._state === State.FALLING || this._state === State.JUMPING) && this._vy >= 0 && this._fallStartY === 0) {
                this._fallStartY = this._y;
            }

            // Physics (Gravity)
            if (this._state === State.FALLING || this._state === State.JUMPING) {
                this._vy += GRAVITY;
            }

            // Stop movement if idle (prevents sliding)
            if (this._state === State.IDLE) {
                this._vx = 0;
            }

            // Update Position
            let prevY = this._y;
            this._x += this._vx;
            this._y += this._vy;

            // Determine current monitor based on "feet" position
            let feetX = this._x + this._displayW / 2;
            let feetY = this._y + this._displayH;

            // Find monitors containing the X coordinate
            let monitors = Main.layoutManager.monitors.filter(m => feetX >= m.x && feetX < m.x + m.width);

            let currentMonitor = null;
            if (monitors.length === 0) {
                currentMonitor = Main.layoutManager.primaryMonitor;
            } else if (monitors.length === 1) {
                currentMonitor = monitors[0];
            } else {
                // Handle vertically stacked monitors
                monitors.sort((a, b) => a.y - b.y);
                currentMonitor = monitors.find(m => feetY < m.y + m.height);
                if (!currentMonitor) currentMonitor = monitors[monitors.length - 1];
            }

            let floorY = currentMonitor.y + currentMonitor.height;

            // Ceiling collision to prevent jumping off-screen and disappearing
            if (this._y < currentMonitor.y) {
                this._y = currentMonitor.y;
                this._vy = 0;
            }

            // --- Logic: Reposition if walking off floor ---
            let onFloorLevel = (this._y + this._displayH) >= floorY - 10;

            if (onFloorLevel) {
                // If walking outside horizontal bounds of the stage, respawn at the top
                if (this._x < -this._displayW || this._x > global.stage.width) {
                    this._respawn();
                    return;
                }
            } else {
                // Routine Wall Bounce when in air or on windows
                let maxX = global.stage.width - this._displayW;
                if (this._x < 0) {
                    this._x = 0;
                    this._vx *= -1;
                } else if (this._x > maxX) {
                    this._x = maxX;
                    this._vx *= -1;
                }
            }

            // --- Collision Detection ---
            let onGround = false;
            let landedOnWindow = null;

            if (this._vy >= 0) { // Only collide if falling downwards
                for (let win of windows) {
                    let rect = win.rect;

                    // Hitbox: Feet within window width AND close to top edge
                    let prevFeetY = prevY + this._displayH;
                    let inHorizontalRange = (feetX >= rect.x) && (feetX <= rect.x + rect.width);
                    let inVerticalRange = (feetY >= rect.y) && (prevFeetY <= rect.y + 25);

                    if (inHorizontalRange && inVerticalRange) {
                        this._y = rect.y - this._displayH;
                        this._vy = 0;
                        onGround = true;
                        landedOnWindow = win;
                        break;
                    }
                }

                // Allow landing on screen bottom (Floor)
                if (!landedOnWindow) {
                    if (feetY >= floorY) {
                        this._y = floorY - this._displayH;
                        this._vy = 0;
                        onGround = true;
                    }
                }
            }

            // // If we landed while still in god mode, forget the fall so no splat triggers later
            if (onGround && this._godMode) {
                // this._isSplatted = true; // Prevent splat
                this._fallStartY = this._y; // Reset fall tracking to current position
            }

            // --- Splat Effect Check ---
            if (this._settings.get_boolean('death-by-high-falls'))
            if (onGround) 
            if (!this._godMode)
            if (!this._isSplatted)
                {
                let screenHeight = global.stage.height;
                let fallHeight = this._y - this._fallStartY;  // Correct: current Y - start Y = positive when falling
                
                if (fallHeight > screenHeight * 0.5) {
                    
                    if (!this._isSplatted)
                    {   console.log('[Gnomelet] _fallStartY:', this._fallStartY);
                        console.log('[Gnomelet] _y:', this._y);
                        console.log('[Gnomelet]  fallHeight:', fallHeight) // 'vs threshold:', screenHeight * 0.5);
                        console.log('[Gnomelet] threshold:', screenHeight * 0.5);
                        console.log('[Gnomelet] SPLAT! Creating effect');
                        console.log('[Gnomelet] =====================================');
                    }                    
                    this._isSplatted = true; // Prevent re-splat
                    this._createSplatEffect(fallHeight);
                    this.actor.visible = false;

                    // Respawn after a short delay
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                        if (this.actor) {
                            this.actor.visible = true;
                            this._respawn();
                        }
                        return GLib.SOURCE_REMOVE;
                    });

                    return;
                }
            }

            // Reset fall tracking on successful landing
            if (onGround) {
                this._fallStartY = this._y;
            }

            // --- Z-Ordering / Layering Logic ---
            if (landedOnWindow && !landedOnWindow.isDock) {
                // If on a window, it must be in the same group to be ordered relative to it
                let parent = this.actor.get_parent();
                if (parent !== global.window_group) {
                    if (parent === Main.layoutManager.uiGroup) {
                        Main.layoutManager.removeChrome(this.actor);
                    } else if (parent) {
                        parent.remove_child(this.actor);
                    }
                    global.window_group.add_child(this.actor);
                }

                global.window_group.set_child_above_sibling(this.actor, landedOnWindow.actor);

            } else {
                // If on the floor, apply calculated Z-order preference (passed from Manager)
                let parent = this.actor.get_parent();

                if (!forceBackground) {
                    if (parent !== Main.layoutManager.uiGroup) {
                        if (parent) parent.remove_child(this.actor);
                        Main.layoutManager.addChrome(this.actor);
                    }

                    // Handle Dash-to-Dock Z-Order
                    // Only reorder if the dock is actually a sibling in uiGroup
                    if (dockContainer && this.actor.get_parent() === Main.layoutManager.uiGroup &&
                        dockContainer.get_parent() === Main.layoutManager.uiGroup) {

                        let dockOrder = this._settings.get_boolean('dock-z-order');
                        if (dockOrder) {
                            // In Front of Dash to Dock
                            Main.layoutManager.uiGroup.set_child_above_sibling(this.actor, dockContainer);
                        } else {
                            // Default: Behind Dash to Dock
                            Main.layoutManager.uiGroup.set_child_below_sibling(this.actor, dockContainer);
                        }
                    }
                } else {
                    // Background Group
                    let bgGroup = Main.layoutManager._backgroundGroup;
                    if (bgGroup && parent !== bgGroup) {
                        if (parent === Main.layoutManager.uiGroup) {
                            Main.layoutManager.removeChrome(this.actor);
                        } else if (parent) {
                            parent.remove_child(this.actor);
                        }
                        bgGroup.add_child(this.actor);
                    }
                }
            }

            // --- State Machine Transitions ---
            if (onGround) {
                // On ground
                if (this._state === State.FALLING || this._state === State.JUMPING) {
                    this._vy = 0;
                    this._pickNewAction();
                }
            } else {
                // Not on ground
                if (this._state !== State.JUMPING) {
                    // Logic: If we were walking and now we are not on ground, we are walking off an edge.
                    let jumped = false;
                    if (this._state === State.WALKING) {
                        // "Jump for falling": Chance to jump when reaching the edge
                        if (Math.random() < 0.5) {
                            this._performJump();
                            jumped = true;
                        }
                    }

                    if (!jumped) {
                        this._state = State.FALLING;
                    }
                }
            }

            // --- AI Behavior ---
            if (this._state === State.WALKING) {
                this._idleTimer = 0;
                // Chance to stop walking
                if (Math.random() < 0.02) {
                    this._state = State.IDLE;
                    this._vx = 0;
                    this._idleTimer = Math.random() * 60 + 20;
                }

                // Logic: "Jump only when useful" - Check for window overhead
                let canJump = false;

                // Let's recalculate precise feet position after collision adjustments
                let currFeetY = this._y + this._displayH;
                let currFeetX = this._x + this._displayW / 2;

                for (let win of windows) {
                    // Skip the window we are currently standing on
                    if (landedOnWindow && win === landedOnWindow) continue;

                    let rect = win.rect;

                    let effectiveMinX = rect.x;
                    let effectiveMaxX = rect.x + rect.width;

                    // Check if window is horizontally within range of our feet
                    // We extend the "virtual" window size if we are approaching it from the side
                    if (currFeetX < rect.x && this.facingRight) {
                        effectiveMinX -= this._jumpReachX;
                    } else if (currFeetX > rect.x + rect.width && !this.facingRight) {
                        effectiveMaxX += this._jumpReachX;
                    }

                    if (currFeetX >= effectiveMinX && currFeetX <= effectiveMaxX) {
                        // Check if window is vertically above us and reachable
                        // Window top (rect.y) must be less than feet (currFeetY)
                        let dist = currFeetY - rect.y;
                        if (dist > 0 && dist <= this._maxJumpHeight) {
                            // Only jump if we can actually fit on top of the target window 
                            // without being blocked by the screen top (ceiling)
                            if (rect.y - this._displayH >= currentMonitor.y) {
                                canJump = true;
                                break;
                            }
                        }
                    }
                }

                // If useful, chance to jump
                if (canJump) {
                    if (Math.random() < 0.25) {
                        this._performJump();
                    }
                }

            } else if (this._state === State.IDLE) {
                this._vx = 0;
                this._idleTimer--;
                if (this._idleTimer <= 0) {
                    this._pickNewAction();
                }
            }

            this._updateAnimation();
            this.actor.set_position(Math.floor(this._x), Math.floor(this._y));
            // this._updateStyle();
        }

        /**
         * Determines if the gnomelet should be in the background layer.
         */
        _isBackgroundMode() {
            let floorMode = this._settings.get_string('floor-z-order');
            if (floorMode === 'allow') return false;

            let focusWindow = global.display.focus_window;
            let focusedIsMaximized = focusWindow && isWindowMaximized(focusWindow);

            if (floorMode === 'partial') {
                return focusedIsMaximized;
            }

            // Disallow logic: Background if ANY visible window is maximized
            if (focusedIsMaximized) return true;

            let actors = global.window_group.get_children();
            for (let actor of actors) {
                if (actor.visible && actor.meta_window && !actor.meta_window.minimized &&
                    actor.meta_window.get_window_type() === Meta.WindowType.NORMAL &&
                    isWindowMaximized(actor.meta_window)) {
                    return true;
                }
            }
            return false;
        }

        /**
         * Sets the initial layer for the actor based on the floor z-order setting.
         */
        _resetLayer() {
            let spawnInBackground = this._isBackgroundMode();
            let parent = this.actor.get_parent();

            if (spawnInBackground) {
                let bgGroup = Main.layoutManager._backgroundGroup;
                if (bgGroup && parent !== bgGroup) {
                    if (parent === Main.layoutManager.uiGroup) {
                        Main.layoutManager.removeChrome(this.actor);
                    } else if (parent) {
                        parent.remove_child(this.actor);
                    }
                    bgGroup.add_child(this.actor);
                }
            } else {
                if (parent !== Main.layoutManager.uiGroup) {
                    if (parent) parent.remove_child(this.actor);
                    Main.layoutManager.addChrome(this.actor);
                }
            }
        }

        /**
         * Generates a random start position above one of the monitors.
         */
        _randomizeStartPos() {
            let monitors = Main.layoutManager.monitors;
            if (!monitors || monitors.length === 0) {
                this._x = Math.floor(Math.random() * (global.stage.width - this._displayW));
                this._y = 0;
            } else {
                let m = monitors[Math.floor(Math.random() * monitors.length)];
                this._x = Math.floor(m.x + Math.random() * (m.width - this._displayW));
                this._y = m.y;
            }

            let spawnOffset = this._settings.get_int('spawn-offset');
            this._y += spawnOffset;
        }

        /**
         * Resets the character to the top.
         */
        _respawn() {
            // Pick new type/identity on respawn
            if (this._resourceProvider) {
                let res = this._resourceProvider(); // Pick random
                if (res) {
                    this._typeName = res.type;
                    this._frameImages = res.frames;
                    this._frameWidth = res.w;
                    this._frameHeight = res.h;
                    this.updateScale();
                }
            }

            this._randomizeStartPos();
            this._vx = 0;
            this._vy = 0;
            this._state = State.FALLING;
            this._fallStartY = 0; // Reset fall tracking
            this._isSplatted = false; // Allow next splat

            // Grant short immortality after respawn
            this._godMode = true;
            
            if (this._godModeTimeoutId) {
                GLib.source_remove(this._godModeTimeoutId);
                this._godModeTimeoutId = null;
            }
            this._godModeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                this._godMode = false;
                this._godModeTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });

            this._resetLayer();
        }

        /**
         * Decides the next action when on the ground.
         */
        _pickNewAction() {
            let r = Math.random();
            if (r < 0.6) {
                this._state = State.WALKING;
                let dir = (Math.random() > 0.5) ? 1 : -1;
                this._vx = dir * WALK_SPEED;
            } else {
                this._state = State.IDLE;
                this._idleTimer = Math.random() * 60 + 20;
            }
        }

        /**
         * Performs a jump.
         */
        _performJump() {
            this._state = State.JUMPING;
            this._vy = this._jumpVelocity;
            let dir = this.facingRight ? 1 : -1;
            this._vx = dir * WALK_SPEED * 2;
        }

        /**
         * Calculates the correct frame based on state and time.
         */
        _updateAnimation() {
            this._animationTimer++;
            let frameIndex = 0;
            switch (this._state) {
                case State.WALKING:
                    let walkFrames = [0, 1, 2, 3];
                    let speed = 4; // Frame changes every 4 ticks
                    let idx = Math.floor(this._animationTimer / speed) % walkFrames.length;
                    frameIndex = walkFrames[idx];
                    break;
                case State.IDLE:
                    frameIndex = 4;
                    break;
                case State.JUMPING:
                case State.FALLING:
                    frameIndex = 5;
                    break;
                case State.DRAGGING:
                    // Cycle between two walking frames
                    let dragFrames = [1, 3];
                    if (this._frameImages[6] && this._frameImages[7]) {
                        dragFrames = [6, 7];
                    }
                    let dragSpeed = 8;
                    let dIdx = Math.floor(this._animationTimer / dragSpeed) % dragFrames.length;
                    frameIndex = dragFrames[dIdx];
                    break;
            }
            this.setFrame(frameIndex);
        }

        /**
         * Applies the frame and handles horizontal flipping (mirroring).
         */
        setFrame(frameIndex) {
            if (this._frame === frameIndex && this._lastFacing === this.facingRight) return;

            this._frame = frameIndex;
            this._lastFacing = this.facingRight;

            if (this._frameImages && this._frameImages[frameIndex]) {
                this._icon.set_gicon(this._frameImages[frameIndex]);
            }

            // Horizontal mirroring
            this._icon.set_pivot_point(0.5, 0.5);
            if (this.facingRight) {
                this._icon.scale_x = 1;
            } else {
                this._icon.scale_x = -1;
            }
        }

        /**
         * Creates a splat particle effect with trailing smear when dying from a high fall.
         */
        _createSplatEffect(fallHeight) {
            try {
                const settingsScale = this._settings.get_int('gnomelet-scale');
                const PARTICLE_SIZE = Math.max(2, Math.floor(settingsScale / 10));
                const RED_SHADES = [
                    '#FF0000', '#FF1744', '#FF5252', '#EF5350', '#E53935',
                    '#D32F2F', '#C62828', '#B71C1C', '#8B0000'
                ];

                let parent = this.actor.get_parent() || Main.layoutManager.uiGroup;

                // All particles spawn at the base (feet) of the character at splat
                const baseX = this._x + this._displayW / 2;
                const baseY = this._y + this._displayH;

                const burstCount = 5; // Number of bursts for a richer effect
                const particlesPerBurst = 10;

                const createParticle = (angle, speed) => {
                    let size = PARTICLE_SIZE + Math.floor(Math.random() * 5);
                    let colorStr = RED_SHADES[Math.floor(Math.random() * RED_SHADES.length)];
                    let particle = new St.Widget({
                        width: size,
                        height: size,
                        style: 'background-color: ' + colorStr + '; border-radius: ' + Math.min(3, Math.floor(size / 2)) + 'px;',
                        x: baseX - (size / 2),
                        y: baseY - (size / 2),
                        visible: true,
                        reactive: false,
                        opacity: 220,
                    });
                    parent.add_child(particle);

                    let vx = Math.cos(angle) * speed * (0.8 + Math.random() * 0.6);
                    let vy = Math.sin(angle) * speed * (0.7 + Math.random() * 0.5) - 2  ; 

                    let screenHeight = global.stage.height;
                    if (fallHeight !== 0) 
                        vy = vy * fallHeight / screenHeight * 1.5; // Scale initial velocity based on fall height for more dramatic effect on higher falls
                    
                    let reachedGround = false;
                    let fadeElapsed = 0;
                    let fadeDuration = 600 + Math.floor(Math.random() * 800);
                    let safetyMax = 4000;
                    let lifetime = 0;

                    let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                        lifetime += 16;
                        if (lifetime > safetyMax) {
                            particle.destroy();
                            return GLib.SOURCE_REMOVE;
                        }

                        if (!reachedGround) {
                            particle.x += vx;
                            vy += GRAVITY * 0.18;
                            particle.y += vy;
                            vx *= 0.98;
                            if (particle.y >= baseY - (size / 2)) {
                                reachedGround = true;
                                particle.y = baseY - (size / 2);
                            }
                        } else {
                            fadeElapsed += 16;
                            particle.opacity = Math.max(0, 220 * (1 - (fadeElapsed / fadeDuration)));
                            particle.x += vx;
                            vx *= 0.94;
                            if (particle.opacity <= 5) {
                                particle.destroy();
                                return GLib.SOURCE_REMOVE;
                            }
                        }
                        return GLib.SOURCE_CONTINUE;
                    });
                };

                // Staggered bursts for a richer effect
                for (let burst = 0; burst < burstCount; burst++) {
                    let burstDelay = burst * 40;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, burstDelay, () => {
                        for (let i = 0; i < particlesPerBurst; i++) {
                            let angle = (Math.PI * 2 * i) / particlesPerBurst + (Math.random() - 0.5) * 0.4;
                            let speed = 3 + Math.random() * 4;

                            if (fallHeight === 0)  {
                                // clicked so angle is random on all directions with upward bias
                                angle = Math.random() * Math.PI * 2;
                            }
                            createParticle(angle, speed);
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
            } catch (e) {
                log('[Gnomelet] ERROR in _createSplatEffect: ' + e.message);
            }
        }

        /**
         * Removes the actor and cleans up references.
         */
        destroy() {
            if (this._godModeTimeoutId) {
                GLib.source_remove(this._godModeTimeoutId);
                this._godModeTimeoutId = null;
            }
            if (this._draggable) {
                if (this._dragBeginId) this._draggable.disconnect(this._dragBeginId);
                if (this._dragEndId) this._draggable.disconnect(this._dragEndId);
                this._draggable = null;
            }
            if (this._clickHandlerId && this.actor) {
                this.actor.disconnect(this._clickHandlerId);
                this._clickHandlerId = null;
            }
            if (this.actor) {
                let parent = this.actor.get_parent();
                if (parent === Main.layoutManager.uiGroup) {
                    Main.layoutManager.removeChrome(this.actor);
                } else if (parent) {
                    parent.remove_child(this.actor);
                }
                this.actor.destroy();
                this.actor = null;
            }
            this._frameImages = [];
        }
    });
