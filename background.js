// Track active state per tab
const activeTabs = new Set();

// Function to inject necessary files
async function injectScript(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ["style.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"],
    });
    activeTabs.add(tabId);
    console.log(`Frames Monitor injected into tab ${tabId}`);
    updateIcon(tabId, true);
  } catch (err) {
    console.error(`Failed to inject script into tab ${tabId}: ${err}`);
    // Clean up if injection fails partially
    removeScript(tabId); // Try to remove if something went wrong
  }
}

// Function to remove files and clean up
async function removeScript(tabId) {
  try {
    // Execute a cleanup function defined within content.js
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      // IMPORTANT: Check if cleanup function exists before calling.
      // This handles cases where the content script might have already been removed or failed to load.
      func: () => {
        if (typeof window.cleanupFramesMonitor === "function") {
          window.cleanupFramesMonitor();
        } else {
          console.log("Cleanup function not found in content script.");
        }
      },
    });
    await chrome.scripting.removeCSS({
      target: { tabId: tabId },
      files: ["style.css"],
    });
    // State cleanup happens after attempting removal
  } catch (err) {
    // Ignore errors if tab is already closed or script isn't there
    if (
      !err.message.includes("No matching script") &&
      !err.message.includes("No tab with id") &&
      !err.message.includes("Cannot access contents of url") && // Handle restricted pages
      !err.message.includes("Missing host permission for the tab")
    ) {
      // Handle permission issues
      console.warn(
        `Could not execute script removal/cleanup in tab ${tabId}: ${err.message}`,
      );
    }
  } finally {
    // Always ensure state is cleaned up locally regardless of script execution success
    activeTabs.delete(tabId);
    console.log(`Frames Monitor state removed for tab ${tabId}`);
    updateIcon(tabId, false); // Attempt to reset icon state
  }
}

// Function to update browser action icon/title
function updateIcon(tabId, isActive) {
  try {
    const state = isActive ? "Active" : "Inactive";
    const title = `Toggle Frames Monitor (${state})`;
    const badgeText = isActive ? "ON" : "";
    const badgeColor = isActive ? "#4CAF50" : "#757575"; // Green for ON, Grey for OFF

    chrome.action.setTitle({ tabId: tabId, title: title });
    chrome.action.setBadgeText({ tabId: tabId, text: badgeText });
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: badgeColor });
  } catch (error) {
    // Ignore errors if the tab doesn't exist anymore
    if (error.message.includes("No tab with id")) {
      // console.log(`Tab ${tabId} not found for icon update.`);
    } else {
      console.warn(`Failed to update icon for tab ${tabId}:`, error);
    }
  }
}

// Listen for clicks on the browser action icon
chrome.action.onClicked.addListener((tab) => {
  // Ensure we have a tab ID and it's not on a restricted page
  if (
    !tab.id ||
    (tab.url &&
      (tab.url.startsWith("chrome://") ||
        tab.url.startsWith("https://chrome.google.com/webstore")))
  ) {
    console.log(`Cannot inject into restricted URL: ${tab.url || "N/A"}`);
    // Optionally provide feedback to the user, e.g., change icon briefly
    if (tab.id) {
      chrome.action.setTitle({
        tabId: tab.id,
        title: "Cannot run on this page",
      });
      chrome.action.setBadgeText({ tabId: tab.id, text: "X" });
      chrome.action.setBadgeBackgroundColor({
        tabId: tab.id,
        color: "#F44336",
      }); // Red X
      setTimeout(() => {
        // Reset icon after a short delay if the tab wasn't active
        if (!activeTabs.has(tab.id)) {
          updateIcon(tab.id, false);
        }
      }, 1500);
    }
    return;
  }

  const currentTabId = tab.id; // Use the correct ID from the tab object

  if (activeTabs.has(currentTabId)) {
    removeScript(currentTabId); // Pass the correct ID
  } else {
    injectScript(currentTabId); // Pass the correct ID
  }
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabs.has(tabId)) {
    activeTabs.delete(tabId);
    console.log(`Cleaned up state for closed tab ${tabId}`);
  }
});

// Clean up when a tab is updated (e.g., navigated away or reloaded)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // If the tab was active and it's reloaded or the URL changes significantly
  if (
    activeTabs.has(tabId) &&
    (changeInfo.status === "loading" || changeInfo.url)
  ) {
    console.log(
      `Detected navigation/reload in active tab ${tabId}. Cleaning up state.`,
    );
    // The content script context is lost on navigation, so just clean up the background state.
    activeTabs.delete(tabId);
    updateIcon(tabId, false); // Update icon to reflect inactive state
  }
});

// Initialize icon state for existing tabs when the extension starts/reloads
chrome.runtime.onStartup.addListener(async () => {
  console.log("Extension startup: Initializing icons.");
  await initializeIconsForAllTabs();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("Extension installed/updated: Initializing icons.");
  await initializeIconsForAllTabs();
  if (details.reason === "install") {
    console.log("First install tasks can go here.");
  } else if (details.reason === "update") {
    console.log("Update tasks can go here.");
  }
});

// Helper to set initial icon states
async function initializeIconsForAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        // Check if the tab URL is accessible before trying to update the icon.
        // This avoids errors for chrome:// pages etc.
        if (
          !tab.url ||
          (!tab.url.startsWith("chrome://") &&
            !tab.url.startsWith("https://chrome.google.com/webstore"))
        ) {
          updateIcon(tab.id, activeTabs.has(tab.id));
        } else {
          // For restricted tabs, ensure they show as inactive/disabled
          updateIcon(tab.id, false);
          chrome.action.setTitle({
            tabId: tab.id,
            title: "Cannot run on this page",
          });
          // Optionally disable the action icon completely for these tabs
          // chrome.action.disable(tab.id);
        }
      }
    }
  } catch (error) {
    console.error("Error initializing icons:", error);
  }
}

// Initial call in case the background script reloads while browser is open
initializeIconsForAllTabs();
