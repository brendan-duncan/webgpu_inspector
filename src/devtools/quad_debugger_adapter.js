// Adapts a fragment-quad scheduler (from createFragmentQuadDebugger) to the
// WgslDebug-like surface the ShaderDebugger UI drives, so the same stepping /
// watch / callstack / breakpoint UI works for fragment shaders. The user drives
// the picked pixel's lane; the scheduler keeps the other three quad lanes in
// lockstep at derivative / texture-sample points so derivatives resolve.

export class QuadDebuggerAdapter {
    constructor(scheduler, runStateChanged) {
        this.scheduler = scheduler;
        this.runStateChanged = runStateChanged ?? null;
    }

    // The quad scheduler runs synchronously, so it is never "running" in the
    // async sense the compute debugger uses; Continue runs to a breakpoint.
    get isRunning() {
        return false;
    }

    get context() {
        return this.scheduler.targetContext;
    }

    get _exec() {
        return this.scheduler.exec;
    }

    get currentState() {
        return this.scheduler.targetFrame;
    }

    get currentCommand() {
        const line = this.scheduler.targetLine;
        return line >= 0 ? { line } : null;
    }

    toggleBreakpoint(lineNo) {
        const bps = this.scheduler.breakpoints;
        if (bps.has(lineNo)) {
            bps.delete(lineNo);
        } else {
            bps.add(lineNo);
        }
    }

    stepInto() {
        this.scheduler.stepTarget(true);
    }

    stepOver() {
        this.scheduler.stepTarget(false);
    }

    stepOut() {
        this.scheduler.stepOutTarget();
    }

    run() {
        this.scheduler.runTarget();
        if (this.runStateChanged) {
            this.runStateChanged();
        }
    }

    pause() {
        // Runs synchronously; nothing to pause.
    }
}
