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
  let mouseupTimestamp = null;
  let mutationObserver = null;
  let timeoutId = null; // For the 2-second timeout after mouseup
  let startMonitoringTimeoutId = null; // For the setTimeout(..., 0) delay
  let displayElement = null;
  let lastMousePosition = { x: 0, y: 0 };

  // --- Helper Functions ---

  /**
   * Calculates the number of frames elapsed for a given duration in milliseconds.
   * @param {number | null} ms - Duration in milliseconds.
   * @returns {{f60: number | string, f120: number | string}} - Frames at 60Hz and 120Hz.
   */
  function calculateFrames(ms) {
    if (ms === null || ms < 0) return { f60: "N/A", f120: "N/A" };
    // Use ceil because even a fraction of a frame interval means the change
    // wouldn't be visible until the *next* frame.
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
    if (!displayElem) return false; // Display element doesn't exist yet

    const target = mutation.target;

    // Ignore style changes *on* the display element (positioning, visibility)
    if (
      mutation.type === "attributes" &&
      target === displayElem &&
      mutation.attributeName === "style"
    ) {
      return true;
    }

    // Ignore text changes *inside* the display element
    if (
      mutation.type === "characterData" &&
      target.parentNode === displayElem
    ) {
      return true;
    }

    // Ignore nodes being added/removed *directly within* the display element
    // (covers text content changes that add/remove text nodes)
    if (mutation.type === "childList" && target === displayElem) {
      return true;
    }

    // Otherwise, it's not an ignorable self-mutation
    return false;
  }

  // --- DOM Manipulation ---

  /**
   * Creates the UI element to display results if it doesn't exist.
   */
  function createDisplayElement() {
    if (displayElement) return;

    displayElement = document.createElement("div");
    displayElement.id = "frames-monitor-display"; // Unique ID
    displayElement.style.position = "fixed";
    displayElement.style.zIndex = "99999";
    displayElement.style.background = "rgba(0, 0, 0, 0.7)";
    displayElement.style.color = "white";
    displayElement.style.padding = "5px 8px";
    displayElement.style.borderRadius = "4px";
    displayElement.style.fontSize = "12px";
    displayElement.style.fontFamily = "monospace";
    displayElement.style.whiteSpace = "pre"; // Preserve line breaks
    displayElement.style.pointerEvents = "none"; // Don't interfere with clicks
    displayElement.style.visibility = "hidden"; // Start hidden
    displayElement.style.left = "0px"; // Initial position
    displayElement.style.top = "0px"; // Initial position
    document.body.appendChild(displayElement);
    // console.log("Frames Monitor: Display element created.");
  }

  /**
   * Updates the position of the display element near the mouse cursor.
   */
  function updateDisplayPosition() {
    if (!displayElement || displayElement.style.visibility === "hidden") return;

    const offsetX = 15; // Offset from cursor
    const offsetY = 15;
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;
    const elWidth = displayElement.offsetWidth;
    const elHeight = displayElement.offsetHeight;

    let finalX = lastMousePosition.x + offsetX;
    let finalY = lastMousePosition.y + offsetY;

    // Keep within viewport boundaries
    if (finalX + elWidth > winWidth - 10) {
      finalX = lastMousePosition.x - elWidth - offsetX; // Flip to left
    }
    if (finalX < 10) {
      finalX = 10; // Min left padding
    }
    if (finalY + elHeight > winHeight - 10) {
      finalY = lastMousePosition.y - elHeight - offsetY; // Flip above
    }
    if (finalY < 10) {
      finalY = 10; // Min top padding
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
        return; // Should not happen, but safety check
      }
    }
    displayElement.textContent = text;
    displayElement.style.visibility = "visible"; // Make it visible
    updateDisplayPosition(); // Position it correctly
  }

  // --- Core Logic & State Management ---

  /**
   * Resets the click timing state.
   */
  function resetState() {
    mousedownTimestamp = null;
    mouseupTimestamp = null;
  }

  /**
   * Stops the MutationObserver and clears any pending timeouts.
   * @param {string} reason - Why monitoring is being stopped.
   */
  function stopMonitoring(reason = "unknown") {
    // Clear the timeout that delays starting the monitor
    if (startMonitoringTimeoutId) {
      clearTimeout(startMonitoringTimeoutId);
      startMonitoringTimeoutId = null;
    }

    // Disconnect the observer if it's active
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
      // console.log(`Frames Monitor: Observer stopped (${reason}).`);
    }

    // Clear the timeout that handles no mutation detected
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  /**
   * Starts the MutationObserver and the timeout check.
   * This is delayed slightly using setTimeout(..., 0) to ensure
   * mouseup event processing is complete before observing.
   */
  function startMonitoring() {
    startMonitoringTimeoutId = null; // Mark the delay timeout as completed

    // Ensure we have valid click times before starting
    if (mouseupTimestamp === null || mousedownTimestamp === null) {
      console.warn(
        "Frames Monitor: Missing click timings. Cannot start observer.",
      );
      resetState();
      updateDisplayText("Click error. Try again.");
      return;
    }

    // console.log("Frames Monitor: Starting MutationObserver and timeout...");
    mutationObserver = new MutationObserver(handleMutation);
    mutationObserver.observe(document.documentElement, {
      childList: true, // Changes to direct children
      subtree: true, // Changes in descendants
      attributes: true, // Attribute changes
      characterData: true, // Text content changes
    });

    // Set a timeout to trigger if no mutation is detected
    timeoutId = setTimeout(handleTimeout, TIMEOUT_DURATION_MS);
  }

  /**
   * Callback for the MutationObserver. Processes detected mutations.
   * @param {MutationRecord[]} mutationsList - List of mutations.
   * @param {MutationObserver} observerInstance - The observer itself.
   */
  function handleMutation(mutationsList, observerInstance) {
    const mutationTimestamp = performance.now();

    // --- Filter out self-mutations ---
    let containsOnlyIgnorableMutations = true;
    for (const mutation of mutationsList) {
      if (!isIgnorableSelfMutation(mutation, displayElement)) {
        containsOnlyIgnorableMutations = false;
        // console.log("Frames Monitor: Relevant mutation found:", mutation);
        break; // Found a relevant mutation, no need to check further
      }
    }

    // If all mutations were ignorable (caused by our display), keep monitoring
    if (containsOnlyIgnorableMutations) {
      // console.log("Frames Monitor: Ignoring self-inflicted mutations.");
      return; // <<< EXIT EARLY
    }
    // --- End of filter ---

    // console.log("Frames Monitor: Relevant mutation detected at", mutationTimestamp);
    stopMonitoring("mutation detected"); // Stop observer and timeout

    // Calculate timings
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

    // Format output string
    let output = `DOM Change Detected:\n`;
    output += `Mousedown → DOM: ${msFromMousedown} ms\n (${framesMousedown.f60}f@60, ${framesMousedown.f120}f@120)\n`;
    output += `Mouseup   → DOM: ${msFromMouseup} ms\n (${framesMouseup.f60}f@60, ${framesMouseup.f120}f@120)`;

    updateDisplayText(output);
    resetState(); // Reset for the next measurement
  }

  /**
   * Callback for the timeout after mouseup when no mutation is detected.
   */
  function handleTimeout() {
    // console.log("Frames Monitor: Monitoring timed out.");
    stopMonitoring("timeout reached");
    updateDisplayText(
      `No relevant DOM change detected\n(Timeout: ${TIMEOUT_DURATION_MS / 1000}s after mouseup)`,
    );
    resetState(); // Reset for the next measurement
  }

  // --- Event Handlers ---

  /**
   * Handles the mousedown event.
   * @param {MouseEvent} event
   */
  function onMouseDown(event) {
    // Only react to the primary button (usually left)
    if (event.button !== 0) return;

    stopMonitoring("new mousedown"); // Stop any previous monitoring
    resetState();
    mousedownTimestamp = performance.now();
    // console.log("Frames Monitor: Mousedown at", mousedownTimestamp);
    updateDisplayText("Mousedown...");
  }

  /**
   * Handles the mouseup event.
   * @param {MouseEvent} event
   */
  function onMouseUp(event) {
    // Only react to the primary button
    if (event.button !== 0) return;

    // Ensure mousedown happened first and mouseup hasn't already been recorded
    if (mousedownTimestamp !== null && mouseupTimestamp === null) {
      mouseupTimestamp = performance.now();
      // console.log("Frames Monitor: Mouseup recorded at", mouseupTimestamp);
      updateDisplayText("Mouseup... Monitoring DOM...");

      // Delay starting the observer slightly to let mouseup event finish processing
      startMonitoringTimeoutId = setTimeout(startMonitoring, 0);
    } else if (mousedownTimestamp === null) {
      // Mouseup happened without a preceding mousedown (e.g., started off-window)
      stopMonitoring("mouseup without mousedown");
      resetState();
      updateDisplayText("Click to measure latency");
    }
  }

  /**
   * Tracks the mouse position to place the display element.
   * @param {MouseEvent} event
   */
  function onMouseMove(event) {
    lastMousePosition.x = event.clientX;
    lastMousePosition.y = event.clientY;
    // Update display position if it's visible (avoids unnecessary calculations)
    if (displayElement && displayElement.style.visibility === "visible") {
      updateDisplayPosition();
    }
  }

  // --- Initialization and Cleanup ---

  /**
   * Initializes the monitor: creates UI, attaches listeners.
   */
  function init() {
    // console.log("Frames Monitor: Running initialization logic.");
    createDisplayElement();

    // Use 'true' for capture phase to catch clicks early, before they might
    // be stopped by other handlers on the page.
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("mousemove", onMouseMove, true); // No capture needed

    updateDisplayText("Click to measure latency");

    // Slightly delay initial positioning to ensure layout is stable
    setTimeout(() => {
      if (displayElement) updateDisplayPosition();
    }, 50);
  }

  /**
   * Cleans up resources: removes listeners, observer, and UI element.
   * Exposed globally for manual cleanup if needed (e.g., from devtools).
   */
  window.cleanupFramesMonitor = function () {
    console.log("Frames Monitor: Cleaning up...");
    stopMonitoring("cleanup requested");
    resetState();

    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("mousemove", onMouseMove, true);

    if (displayElement && displayElement.parentNode) {
      displayElement.parentNode.removeChild(displayElement);
      // console.log("Frames Monitor: Display element removed.");
    }
    displayElement = null;

    window.framesMonitorActive = false;
    // Attempt to remove the cleanup function itself from the global scope
    try {
      delete window.cleanupFramesMonitor;
    } catch (e) {
      window.cleanupFramesMonitor = undefined; // Fallback for environments where delete might fail
    }
    console.log("Frames Monitor: Cleanup complete.");
  };

  // --- Start Execution ---
  if (document.readyState === "loading") {
    // Wait for the DOM to be ready if script runs early
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // DOM is already ready, initialize immediately
    init();
  }
})();
