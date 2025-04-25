(function () {
  // --- Configuration ---
  const TIMEOUT_DURATION_MS = 2000; // Time after mouseup to wait for DOM change before timing out.

  // --- Prevent Multiple Instances ---
  if (window.framesMonitorActive) {
    console.warn("Frames Monitor: Already active. Aborting initialization.");
    return;
  }
  window.framesMonitorActive = true;
  console.log("Frames Monitor: Initializing...");

  // --- State Variables ---
  let mousedownTimestamp = null;
  let mouseupTimestamp = null; // Still needed for the second measurement
  let mutationObserver = null; // The main observer started after mouseup
  let earlyMutationObserver = null; // Observer started immediately on mousedown
  let timeoutId = null; // For the timeout after mouseup
  let startMonitoringTimeoutId = null; // For the setTimeout(..., 0) delay
  let displayElement = null;
  let lastMousePosition = { x: 0, y: 0 };
  let mutationDetectedBeforeMouseup = false; // Flag to track early detection

  // --- Helper Functions --- (calculateFrames, isIgnorableSelfMutation - unchanged)

  /**
   * Calculates the number of frames elapsed for a given duration in milliseconds.
   * @param {number | null} ms - Duration in milliseconds.
   * @returns {{f60: number | string, f120: number | string}} - Frames at 60Hz and 120Hz.
   */
  function calculateFrames(ms) {
    if (ms === null || ms < 0) return { f60: "N/A", f120: "N/A" };
    const frames60 = Math.ceil(ms / (1000 / 60));
    const frames120 = Math.ceil(ms / (1000 / 120));
    return { f60: frames60, f120: frames120 };
  }

  /**
   * Checks if a mutation record should be ignored because it was likely caused
   * by the monitor's own display element updating its style or text.
   * @param {MutationRecord} mutation - The mutation record.
   * @param {HTMLElement} displayElem - The display element instance.
   * @returns {boolean} - True if the mutation should be ignored.
   */
  function isIgnorableSelfMutation(mutation, displayElem) {
    if (!displayElem) return false;
    const target = mutation.target;
    if (
      mutation.type === "attributes" &&
      target === displayElem &&
      mutation.attributeName === "style"
    ) {
      return true;
    }
    if (
      mutation.type === "characterData" &&
      target.parentNode === displayElem
    ) {
      return true;
    }
    if (mutation.type === "childList" && target === displayElem) {
      return true;
    }
    return false;
  }

  // --- DOM Manipulation --- (createDisplayElement, updateDisplayPosition, updateDisplayText - unchanged)
  /**
   * Creates the UI element to display results if it doesn't exist.
   */
  function createDisplayElement() {
    if (displayElement) return;
    displayElement = document.createElement("div");
    displayElement.id = "frames-monitor-display";
    displayElement.style.position = "fixed";
    displayElement.style.zIndex = "99999";
    displayElement.style.background = "rgba(0, 0, 0, 0.7)";
    displayElement.style.color = "white";
    displayElement.style.padding = "5px 8px";
    displayElement.style.borderRadius = "4px";
    displayElement.style.fontSize = "12px";
    displayElement.style.fontFamily = "monospace";
    displayElement.style.whiteSpace = "pre";
    displayElement.style.pointerEvents = "none";
    displayElement.style.visibility = "hidden";
    displayElement.style.left = "0px";
    displayElement.style.top = "0px";
    document.body.appendChild(displayElement);
  }

  /**
   * Updates the position of the display element near the mouse cursor.
   */
  function updateDisplayPosition() {
    if (!displayElement || displayElement.style.visibility === "hidden") return;
    const offsetX = 15;
    const offsetY = 15;
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;
    const elWidth = displayElement.offsetWidth;
    const elHeight = displayElement.offsetHeight;
    let finalX = lastMousePosition.x + offsetX;
    let finalY = lastMousePosition.y + offsetY;
    if (finalX + elWidth > winWidth - 10) {
      finalX = lastMousePosition.x - elWidth - offsetX;
    }
    if (finalX < 10) {
      finalX = 10;
    }
    if (finalY + elHeight > winHeight - 10) {
      finalY = lastMousePosition.y - elHeight - offsetY;
    }
    if (finalY < 10) {
      finalY = 10;
    }
    displayElement.style.left = `${finalX}px`;
    displayElement.style.top = `${finalY}px`;
  }

  /**
   * Updates the text content of the display element and makes it visible.
   * @param {string} text - The text to display.
   */
  function updateDisplayText(text) {
    if (!displayElement) {
      createDisplayElement();
      if (!displayElement) {
        console.error("Frames Monitor: Failed to create display element.");
        return;
      }
    }
    displayElement.textContent = text;
    displayElement.style.visibility = "visible";
    updateDisplayPosition();
  }

  // --- Core Logic & State Management ---

  /**
   * Resets the click timing state and flag. Called ONLY on mousedown.
   */
  function resetState() {
    mousedownTimestamp = null;
    mouseupTimestamp = null;
    mutationDetectedBeforeMouseup = false; // Reset the flag
  }

  /**
   * Stops *all* MutationObservers and clears any pending timeouts.
   * @param {string} reason - Why monitoring is being stopped.
   */
  function stopMonitoring(reason = "unknown") {
    if (startMonitoringTimeoutId) {
      clearTimeout(startMonitoringTimeoutId);
      startMonitoringTimeoutId = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
      // console.log(`Frames Monitor: Main observer stopped (${reason}).`);
    }
    if (earlyMutationObserver) {
      earlyMutationObserver.disconnect();
      earlyMutationObserver = null;
      // console.log(`Frames Monitor: Early observer stopped (${reason}).`);
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  /**
   * Starts the *main* MutationObserver (after mouseup) and the timeout check.
   */
  function startMainMonitoring() {
    startMonitoringTimeoutId = null; // Mark the delay timeout as completed

    if (mouseupTimestamp === null || mousedownTimestamp === null) {
      console.warn("Frames Monitor: Missing click timings for main observer.");
      // Don't reset state here, mousedown handles reset
      updateDisplayText("Click error. Try again.");
      return;
    }

    // console.log("Frames Monitor: Starting MAIN MutationObserver and timeout...");
    mutationObserver = new MutationObserver(handleMutation); // Use the main handler
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    timeoutId = setTimeout(handleTimeout, TIMEOUT_DURATION_MS);
  }

  /**
   * Callback for the *main* MutationObserver (post-mouseup). Processes detected mutations.
   * @param {MutationRecord[]} mutationsList - List of mutations.
   */
  function handleMutation(mutationsList) {
    const mutationTimestamp = performance.now();

    let containsOnlyIgnorableMutations = true;
    for (const mutation of mutationsList) {
      if (!isIgnorableSelfMutation(mutation, displayElement)) {
        containsOnlyIgnorableMutations = false;
        break;
      }
    }

    if (containsOnlyIgnorableMutations) return; // Exit early

    stopMonitoring("mutation detected post-mouseup"); // Stop observers and timeout

    const msFromMousedown =
      mousedownTimestamp !== null
        ? (mutationTimestamp - mousedownTimestamp).toFixed(1)
        : "N/A";
    const framesMousedown = calculateFrames(
      mousedownTimestamp !== null
        ? mutationTimestamp - mousedownTimestamp
        : null,
    );
    const msFromMouseup =
      mouseupTimestamp !== null
        ? (mutationTimestamp - mouseupTimestamp).toFixed(1)
        : "N/A";
    const framesMouseup = calculateFrames(
      mouseupTimestamp !== null ? mutationTimestamp - mouseupTimestamp : null,
    );

    let output = `DOM Change Detected:\n`;
    output += `Mousedown → DOM: ${msFromMousedown} ms\n (${framesMousedown.f60}f@60, ${framesMousedown.f120}f@120)\n`;
    output += `Mouseup   → DOM: ${msFromMouseup} ms\n (${framesMouseup.f60}f@60, ${framesMouseup.f120}f@120)`;

    updateDisplayText(output);
    // Don't reset state here, wait for next mousedown
  }

  /**
   * Callback for the *early* MutationObserver (post-mousedown).
   * Specifically handles mutations detected *before* mouseup.
   * @param {MutationRecord[]} mutationsList - List of mutations.
   */
  function handleEarlyMutation(mutationsList) {
    const mutationTimestamp = performance.now(); // Capture time immediately

    let containsOnlyIgnorableMutations = true;
    for (const mutation of mutationsList) {
      if (!isIgnorableSelfMutation(mutation, displayElement)) {
        containsOnlyIgnorableMutations = false;
        break;
      }
    }

    if (containsOnlyIgnorableMutations) return; // Exit early

    // --- Mutation detected before mouseup! ---
    mutationDetectedBeforeMouseup = true; // Set the flag
    stopMonitoring("mutation detected pre-mouseup"); // Stop observers

    const msFromMousedown =
      mousedownTimestamp !== null
        ? (mutationTimestamp - mousedownTimestamp).toFixed(1)
        : "N/A";
    const framesMousedown = calculateFrames(
      mousedownTimestamp !== null
        ? mutationTimestamp - mousedownTimestamp
        : null,
    );

    let output = `DOM Change Detected (Pre-Mouseup):\n`;
    output += `Mousedown → DOM: ${msFromMousedown} ms\n (${framesMousedown.f60}f@60, ${framesMousedown.f120}f@120)`;

    updateDisplayText(output);
    // *** REMOVED resetState() call here ***
    // Let the result persist until the next mousedown.
  }

  /**
   * Callback for the timeout after mouseup when no mutation is detected by the main observer.
   */
  function handleTimeout() {
    stopMonitoring("timeout reached");
    updateDisplayText(
      `No relevant DOM change detected\n(Timeout: ${TIMEOUT_DURATION_MS / 1000}s after mouseup)`,
    );
    // Don't reset state here, wait for next mousedown
  }

  // --- Event Handlers ---

  /**
   * Handles the mousedown event. Starts the *early* observer and resets state.
   * @param {MouseEvent} event
   */
  function onMouseDown(event) {
    if (event.button !== 0) return;

    // --- This is the ONLY place state is reset now ---
    stopMonitoring("new mousedown"); // Stop any previous monitoring just in case
    resetState(); // Reset state for the new measurement cycle

    mousedownTimestamp = performance.now();
    updateDisplayText("Mousedown... Watching..."); // Update text

    // Start the EARLY observer immediately
    // console.log("Frames Monitor: Starting EARLY MutationObserver...");
    earlyMutationObserver = new MutationObserver(handleEarlyMutation);
    earlyMutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  }

  /**
   * Handles the mouseup event. Starts the *main* observer if no early mutation was detected.
   * Does NOT reset state.
   * @param {MouseEvent} event
   */
  function onMouseUp(event) {
    if (event.button !== 0) return;

    // If mousedown didn't happen first (e.g., mouseup without prior mousedown in window)
    // or if an early mutation already handled it, do nothing.
    if (mousedownTimestamp === null) {
      // Don't reset state here, just update display if needed
      updateDisplayText("Click to measure latency");
      return;
    }
    if (mutationDetectedBeforeMouseup) {
      // console.log("Frames Monitor: Mouseup ignored, early mutation already handled.");
      // State was *not* reset by handleEarlyMutation, result persists.
      return; // Do nothing, let the early result display
    }

    // --- No early mutation detected, proceed with normal mouseup logic ---

    // Stop the early observer - it's no longer needed for this cycle
    if (earlyMutationObserver) {
      earlyMutationObserver.disconnect();
      earlyMutationObserver = null;
      // console.log("Frames Monitor: Stopped EARLY MutationObserver on mouseup.");
    }

    // Record mouseup time if not already recorded for this cycle
    if (mouseupTimestamp === null) {
      mouseupTimestamp = performance.now();
      // console.log("Frames Monitor: Mouseup recorded at", mouseupTimestamp);
      updateDisplayText("Mouseup... Monitoring DOM..."); // Standard message

      // Delay starting the MAIN observer slightly
      startMonitoringTimeoutId = setTimeout(startMainMonitoring, 0);
    }
  }

  /**
   * Tracks the mouse position to place the display element.
   * @param {MouseEvent} event
   */
  function onMouseMove(event) {
    lastMousePosition.x = event.clientX;
    lastMousePosition.y = event.clientY;
    if (displayElement && displayElement.style.visibility === "visible") {
      updateDisplayPosition();
    }
  }

  // --- Initialization and Cleanup --- (init, window.cleanupFramesMonitor - mostly unchanged)

  /**
   * Initializes the monitor: creates UI, attaches listeners.
   */
  function init() {
    createDisplayElement();
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("mousemove", onMouseMove, true);
    updateDisplayText("Click to measure latency"); // Initial message
    setTimeout(() => {
      if (displayElement) updateDisplayPosition();
    }, 50);
  }

  /**
   * Cleans up resources: removes listeners, observer, and UI element.
   */
  window.cleanupFramesMonitor = function () {
    console.log("Frames Monitor: Cleaning up...");
    stopMonitoring("cleanup requested"); // Stops all observers
    // No explicit resetState() needed here, as next mousedown will handle it.
    // Or can keep it if cleanup should always clear state immediately. Let's keep it for explicit cleanup.
    resetState(); // Explicitly clear state on full cleanup

    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    if (displayElement && displayElement.parentNode) {
      displayElement.parentNode.removeChild(displayElement);
    }
    displayElement = null;
    window.framesMonitorActive = false;
    try {
      delete window.cleanupFramesMonitor;
    } catch (e) {
      window.cleanupFramesMonitor = undefined;
    }
    console.log("Frames Monitor: Cleanup complete.");
  };

  // --- Start Execution ---
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
