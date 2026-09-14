/** Re-open the toolbar popup, or a thin result-only window if openPopup fails. */

export async function restoreWalletUiAfterConfirm(): Promise<void> {
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup()
      return
    }
  } catch {
    // Fall through to thin result window.
  }

  const url = chrome.runtime.getURL('popup.html?durable=1&result=1')
  await new Promise<void>((resolve, reject) => {
    chrome.windows.create(
      {
        url,
        type: 'popup',
        width: 360,
        height: 600,
        focused: true,
      },
      () => {
        const err = chrome.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve()
      }
    )
  })
}
