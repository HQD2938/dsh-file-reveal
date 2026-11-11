/**
 * dsh-file-reveal — browser half.
 *
 * Makes the file paths that appear in a conversation clickable: a plain click
 * reveals the file in the operating system's file manager (Explorer / Finder /
 * xdg-open), Alt+click opens it with the default application, and Ctrl/⌘+click
 * is left to the stock DSH behaviour (sidebar preview / new tab).
 *
 * Everything native stays in the Host: the click handler asks the shipped
 * Session Remote `openWorkspacePath`, which verifies the path through the
 * composed filesystem before launching the desktop opener. This bundle only
 * decides *which* DOM text is a path and resolves relative paths against the
 * current Session working directory.
 *
 * The file is a hand-written DSH client module: `dsh-client-modules` serves it
 * verbatim and the browser loader executes the `__ModuleLoader__.load` call
 * below, so it needs no build step and no npm dependencies.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-reveal',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')

    // ------------------------------------------------------------------ //
    // Constants
    // ------------------------------------------------------------------ //

    /** Only text inside the chat region of a conversation is eligible. */
    var CHAT_SELECTOR = '[data-conversation-region="chat"]'
    /** The composer shares that region but must never be decorated. */
    var COMPOSER_SELECTOR = '[data-conversation-region="composer"], [data-composer-seat]'
    /** Written by the Conversation root; carries the Session id as its value. */
    var SESSION_SELECTOR = '[data-conversation-session]'

    var HINT_ATTRIBUTE = 'data-dsh-file-reveal-hint'
    var STYLE_ATTRIBUTE = 'data-dsh-file-reveal-style'
    var STORAGE_ENABLED = 'dsh.file-reveal.enabled'
    var STORAGE_HINT_SHOWN = 'dsh.file-reveal.hint-shown'
    var MAX_TOKEN_LENGTH = 320

    var DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/
    var UNC_PREFIX = /^\\\\[^\\/]+[\\/]/
    var POSIX_ABSOLUTE = /^\/(?!\/)/

    // ------------------------------------------------------------------ //
    // Copy (kept tiny; the plugin follows the page language, not the DSH
    // locale service, so a missing locale cannot keep the plugin from applying)
    // ------------------------------------------------------------------ //

    var zh = true
    try {
      zh = /^zh/i.test(String(window.navigator.language || 'zh'))
    } catch (error) {
      zh = true
    }

    var STRINGS = zh
      ? {
          toggleOn: '文件路径快捷打开：已开启（点击停用）',
          toggleOff: '文件路径快捷打开：已停用（点击启用）',
          hint: '点击在文件资源管理器中定位；Alt+点击用默认应用打开；Ctrl+点击保留原行为',
          hintOnce:
            '文件路径快捷打开已启用：点击对话中的文件路径即可在资源管理器中定位（Alt+点击用默认应用打开，Ctrl+点击保留原行为）',
          revealed: '已在文件资源管理器中定位',
          opened: '已用默认应用打开',
          failed: '无法打开',
          unresolved: '无法解析为绝对路径',
          unavailable: '当前部署不支持打开本机文件',
          rejected: 'Host 拒绝了该路径',
          unknownError: '未知错误',
        }
      : {
          toggleOn: 'Quick-open file paths: on (click to disable)',
          toggleOff: 'Quick-open file paths: off (click to enable)',
          hint:
            'Click to reveal in the file manager; Alt+click opens with the default app; Ctrl+click keeps the stock behaviour',
          hintOnce:
            'Quick-open file paths is on: click a file path in the conversation to reveal it in the file manager (Alt+click opens it, Ctrl+click keeps the stock behaviour)',
          revealed: 'Revealed in the file manager',
          opened: 'Opened with the default application',
          failed: 'Could not open',
          unresolved: 'Could not resolve an absolute path',
          unavailable: 'This deployment cannot open local files',
          rejected: 'The Host rejected the path',
          unknownError: 'Unknown error',
        }

    function t(key) {
      return STRINGS[key] || key
    }

    // ------------------------------------------------------------------ //
    // Pure path rules (exported through `__test` for the Node test suite)
    // ------------------------------------------------------------------ //

    function isAbsolutePath(value) {
      return (
        DRIVE_ABSOLUTE.test(value) || UNC_PREFIX.test(value) || POSIX_ABSOLUTE.test(value)
      )
    }

    /** Drop the quotes / brackets / sentence punctuation surrounding an inline token. */
    function stripWrapping(raw) {
      var value = String(raw === null || raw === undefined ? '' : raw).trim()
      // Two passes: a closing quote may sit outside a Chinese comma, e.g. `“…”，`.
      for (var pass = 0; pass < 2; pass++) {
        value = value.replace(/[，。；、！？,;!?]+$/, '').trim()
        value = value.replace(/^[\s"'`“”‘’<(\[【《〈（]+/, '')
        value = value.replace(/[\s"'`“”‘’>)\]】》〉）]+$/, '')
      }
      return value
    }

    /** Drop a trailing `:24`, `:24-30`, `#L24` or `#L24-L30` source anchor. */
    function stripLineSuffix(value) {
      var stripped = value.replace(/#L\d+(?:[-–—]L?\d+)?$/i, '')
      var match = /:(\d+)(?:[-–—](\d+))?$/.exec(stripped)
      if (match !== null) {
        var head = stripped.slice(0, match.index)
        // `D:` alone is a drive, not a line anchor.
        if (!/^[A-Za-z]$/.test(head)) stripped = head
      }
      return stripped
    }

    /** Convert a `file:///…` URL to a native path, or return null for other values. */
    function fileUrlToPath(value) {
      if (!/^file:/i.test(value)) return null
      var url
      try {
        url = new URL(value)
      } catch (error) {
        return null
      }
      var pathname = url.pathname || ''
      try {
        pathname = decodeURIComponent(pathname)
      } catch (error) {
        // Keep the percent-encoded form; it is still better than nothing.
      }
      if (url.host && url.host !== 'localhost') {
        return '\\\\' + url.host + pathname.replace(/\//g, '\\')
      }
      if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1)
      return pathname.replace(/\//g, '\\')
    }

    /**
     * Read one inline token as a filesystem path.
     * @param raw - the text of an inline-code token, a button title, or a link destination.
     * @returns the normalized path, or null when the token is not a path.
     */
    function parsePathToken(raw) {
      if (typeof raw !== 'string') return null
      var value = stripWrapping(raw)
      if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) return null
      if (/[\r\n\t]/.test(value)) return null
      if (/^(?:https?|mailto|data|blob|javascript|about|chrome|dsh-[a-z-]+):/i.test(value)) return null
      var filePath = fileUrlToPath(value)
      if (filePath !== null) value = filePath
      value = stripLineSuffix(value)
      if (value.length === 0) return null
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !DRIVE_ABSOLUTE.test(value)) return null
      if (value.charAt(0) === '~') return null
      if (value.charAt(0) === '-') return null
      if (/[*?"<>|]/.test(value)) return null
      if (isAbsolutePath(value)) return value
      // Relative tokens: require a separator and either an explicit relative
      // prefix, a file-ish basename, or at least two separators (directory).
      if (value.indexOf(':') >= 0) return null
      if (/\s/.test(value)) return null
      var separators = (value.match(/[\\/]/g) || []).length
      if (separators === 0) return null
      if (/^\.\.?[\\/]/.test(value)) return value
      // A trailing separator marks a directory mention (`research/preview/`).
      if (/[\\/]$/.test(value)) return value.length > 2 ? value : null
      var base = baseName(value)
      if (base === '' || base === '.' || base === '..') return null
      if (/\.[A-Za-z0-9_+-]{1,12}$/.test(base)) return value
      if (separators >= 2) return value
      return null
    }

    /** Last path segment (file or directory name). */
    function baseName(value) {
      var parts = String(value).split(/[\\/]/)
      return parts.length === 0 ? String(value) : parts[parts.length - 1]
    }

    /** Collapse `.` / `..` segments and unify separators. */
    function normalizeJoined(value, separator) {
      var prefix = ''
      var rest = value
      if (/^[A-Za-z]:/.test(rest)) {
        prefix = rest.slice(0, 2)
        rest = rest.slice(2)
      } else if (rest.slice(0, 2) === '\\\\') {
        prefix = '\\\\'
        rest = rest.slice(2)
      } else if (rest.charAt(0) === '/') {
        prefix = '/'
        rest = rest.slice(1)
      }
      var parts = rest.split(separator === '\\' ? /[\\/]+/ : /\/+/)
      var output = []
      for (var index = 0; index < parts.length; index++) {
        var part = parts[index]
        if (part === '' || part === '.') continue
        if (part === '..') {
          if (output.length > 0) output.pop()
          continue
        }
        output.push(part)
      }
      if (separator === '\\') {
        if (prefix === '\\\\') return '\\\\' + output.join('\\')
        return prefix + '\\' + output.join('\\')
      }
      if (output.length === 0) return prefix === '/' ? '/' : '/'
      return '/' + output.join('/')
    }

    /**
     * Turn a parsed token into the absolute Host path the Session Remote needs.
     * @param token - value returned by {@link parsePathToken}.
     * @param cwd - Session working directory, the base for relative tokens.
     * @returns the absolute path, or null when a relative token has no base.
     */
    function resolveToAbsolute(token, cwd) {
      if (typeof token !== 'string' || token.length === 0) return null
      if (isAbsolutePath(token)) return token
      if (typeof cwd !== 'string' || cwd.length === 0) return null
      var base = cwd.trim().replace(/[\\/]+$/, '')
      if (base.length === 0) return null
      var windows = DRIVE_ABSOLUTE.test(base) || base.slice(0, 2) === '\\\\'
      var separator = windows ? '\\' : '/'
      var relative = token.replace(/[\\/]+/g, separator)
      return normalizeJoined(base + separator + relative, separator)
    }

    /** Read a link destination as a file path, ignoring non-file schemes. */
    function tokenFromHref(href) {
      if (typeof href !== 'string' || href.length === 0) return null
      if (/^(?:https?|mailto|javascript|data|blob|about):/i.test(href)) return null
      var decoded = href
      try {
        decoded = decodeURIComponent(href)
      } catch (error) {
        // Percent-decoding is best effort.
      }
      return parsePathToken(decoded)
    }

    // ------------------------------------------------------------------ //
    // Small observable stores shared by the DOM handler and the header toggle
    // ------------------------------------------------------------------ //

    var state = {
      /** null = not read yet, true/false = user preference. */
      enabled: null,
      /** null = unknown, true/false = the Host desktop can open paths. */
      available: null,
      /** One-time "it works like this" toast. */
      hintShown: false,
      /** Session id -> last known working directory. */
      cwdBySession: {},
      lastCwd: null,
    }

    var enabledListeners = new Set()
    var availableListeners = new Set()

    function readStored(key) {
      try {
        return window.localStorage.getItem(key)
      } catch (error) {
        return null
      }
    }

    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch (error) {
        // Storage may be unavailable (private mode); the session keeps the value.
      }
    }

    function isEnabled() {
      if (state.enabled === null) {
        state.enabled = readStored(STORAGE_ENABLED) !== '0'
        state.hintShown = readStored(STORAGE_HINT_SHOWN) === '1'
      }
      return state.enabled
    }

    function setEnabled(next) {
      if (state.enabled === next) return
      state.enabled = next
      writeStored(STORAGE_ENABLED, next ? '1' : '0')
      enabledListeners.forEach(function (listener) {
        try {
          listener()
        } catch (error) {
          // A listener throwing must not break the toggle.
        }
      })
    }

    function subscribeEnabled(listener) {
      enabledListeners.add(listener)
      return function () {
        enabledListeners.delete(listener)
      }
    }

    function getAvailable() {
      return state.available
    }

    function subscribeAvailable(listener) {
      availableListeners.add(listener)
      return function () {
        availableListeners.delete(listener)
      }
    }

    function setAvailable(next) {
      if (state.available === next) return
      state.available = next
      availableListeners.forEach(function (listener) {
        try {
          listener()
        } catch (error) {
          // Ignore listener failures.
        }
      })
    }

    // ------------------------------------------------------------------ //
    // DOM surfaces: hints, toasts, click delegation
    // ------------------------------------------------------------------ //

    var STYLE_TEXT = [
      '.dshfr-toggle{width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary,#8b93a1));display:inline-flex;',
      'align-items:center;justify-content:center;cursor:pointer;flex:none;',
      'transition:background-color .12s ease,color .12s ease,opacity .12s ease;}',
      '.dshfr-toggle:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));',
      'color:var(--dsw-alias-label-primary,#111);}',
      '.dshfr-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px;}',
      '.dshfr-toggle-off{opacity:.42;}',
      '[data-dsh-file-reveal-hint]{cursor:pointer !important;text-decoration-line:underline !important;',
      'text-decoration-style:dashed !important;text-underline-offset:3px;',
      'text-decoration-color:var(--dsw-alias-brand-primary,#4f6ef7);}',
      '.dshfr-toasts{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483000;',
      'display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;width:max-content;',
      'max-width:min(620px,88vw);}',
      '.dshfr-toast{display:flex;gap:8px;align-items:baseline;max-width:100%;padding:8px 12px;border-radius:10px;',
      'border:.5px solid var(--dsw-alias-border-l2,#d5d8dd);background:var(--dsw-alias-bg-layer-1,#fff);',
      'color:var(--dsw-alias-label-primary,#111);box-shadow:0 8px 28px rgba(0,0,0,.18);font-size:12px;',
      'line-height:1.55;opacity:0;transform:translateY(6px);',
      'transition:opacity .18s ease,transform .18s ease;}',
      '.dshfr-toast-visible{opacity:1;transform:translateY(0);}',
      '.dshfr-toast-text{flex:none;font-weight:500;}',
      '.dshfr-toast-detail{color:var(--dsw-alias-label-secondary,#6b7280);overflow-wrap:anywhere;min-width:0;}',
      '.dshfr-toast-ok .dshfr-toast-text{color:var(--dsw-alias-state-success-primary,#1a7f37);}',
      '.dshfr-toast-error .dshfr-toast-text{color:var(--dsw-alias-state-error-primary,#c0392b);}',
    ].join('')

    var styleElement = null
    var toastHost = null
    var hintedElement = null
    var timers = []

    function later(callback, delay) {
      var id = window.setTimeout(function () {
        var index = timers.indexOf(id)
        if (index >= 0) timers.splice(index, 1)
        try {
          callback()
        } catch (error) {
          // Timers must never throw into the page.
        }
      }, delay)
      timers.push(id)
      return id
    }

    function clearHint() {
      if (hintedElement === null) return
      var element = hintedElement
      hintedElement = null
      try {
        element.removeAttribute(HINT_ATTRIBUTE)
        if (element.getAttribute('title') === t('hint')) element.removeAttribute('title')
      } catch (error) {
        // Detached nodes are fine.
      }
    }

    function showHint(element) {
      if (hintedElement === element) return
      clearHint()
      if (element === null) return
      hintedElement = element
      try {
        element.setAttribute(HINT_ATTRIBUTE, '')
        if (!element.hasAttribute('title')) element.setAttribute('title', t('hint'))
      } catch (error) {
        // Non-elements are ignored by the caller.
      }
    }

    function ensureToastHost() {
      if (toastHost !== null && toastHost.isConnected === true) return toastHost
      toastHost = document.createElement('div')
      toastHost.className = 'dshfr-toasts'
      toastHost.setAttribute('role', 'status')
      toastHost.setAttribute('aria-live', 'polite')
      document.body.appendChild(toastHost)
      return toastHost
    }

    function showToast(kind, message, detail) {
      try {
        var host = ensureToastHost()
        var item = document.createElement('div')
        item.className = 'dshfr-toast dshfr-toast-' + kind
        var text = document.createElement('span')
        text.className = 'dshfr-toast-text'
        text.textContent = (kind === 'ok' ? '✓ ' : '⚠ ') + message
        item.appendChild(text)
        if (typeof detail === 'string' && detail.length > 0) {
          var extra = document.createElement('span')
          extra.className = 'dshfr-toast-detail'
          extra.textContent = detail
          item.appendChild(extra)
        }
        host.appendChild(item)
        window.requestAnimationFrame
          ? window.requestAnimationFrame(function () {
              item.classList.add('dshfr-toast-visible')
            })
          : item.classList.add('dshfr-toast-visible')
        later(function () {
          item.classList.remove('dshfr-toast-visible')
          later(function () {
            if (item.parentNode !== null) item.parentNode.removeChild(item)
          }, 220)
        }, kind === 'error' ? 4200 : 2400)
      } catch (error) {
        // Toast failures are cosmetic.
      }
    }

    /** True when the user is currently selecting text; path clicks must not hijack that. */
    function hasTextSelection() {
      try {
        var selection = window.getSelection()
        return selection !== null && selection !== undefined && String(selection).trim().length > 0
      } catch (error) {
        return false
      }
    }

    /**
     * Read a button as a file token without hijacking ordinary card rows: the
     * button text itself must be the path, or the button title must end with
     * the visible text (the shipped "file mention" shape).
     */
    function tokenFromButton(button) {
      var visible = ''
      try {
        visible = (button.textContent || '').trim()
      } catch (error) {
        visible = ''
      }
      var fromText = parsePathToken(visible)
      if (fromText !== null) return fromText
      var title = ''
      try {
        title = button.getAttribute('title') || ''
      } catch (error) {
        title = ''
      }
      var fromTitle = parsePathToken(title)
      if (fromTitle === null) return null
      if (visible.length === 0) return null
      if (visible === baseName(fromTitle)) return fromTitle
      if (fromTitle.slice(-visible.length) === visible) return fromTitle
      return null
    }

    /**
     * Find the path-bearing element under a DOM node.
     * @param target - the event target.
     * @returns `{ element, token }`, or null when the node carries no path.
     */
    function locateCandidate(target) {
      if (!target || typeof target.closest !== 'function') return null
      if (target.closest('pre, input, textarea, [contenteditable="true"], [contenteditable=""]')) {
        return null
      }
      var button = target.closest('button')
      if (button !== null) {
        var buttonToken = tokenFromButton(button)
        return buttonToken === null ? null : { element: button, token: buttonToken }
      }
      var code = target.closest('code')
      if (code !== null) {
        var codeToken = parsePathToken(code.textContent || '')
        return codeToken === null ? null : { element: code, token: codeToken }
      }
      var anchor = target.closest('a')
      if (anchor !== null) {
        var hrefToken = tokenFromHref(anchor.getAttribute('href') || '')
        if (hrefToken !== null) return { element: anchor, token: hrefToken }
        var textToken = parsePathToken(anchor.textContent || '')
        return textToken === null ? null : { element: anchor, token: textToken }
      }
      return null
    }

    /** Session working directory for the conversation a click happened in. */
    function cwdForSession(sessionId) {
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        try {
          var snapshot = ctxRef.sessions.list.getSnapshot()
          var row = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined
          if (row && typeof row.cwd === 'string' && row.cwd.length > 0) {
            state.cwdBySession[sessionId] = row.cwd
            state.lastCwd = row.cwd
            return row.cwd
          }
        } catch (error) {
          // Fall through to the remembered value.
        }
        if (typeof state.cwdBySession[sessionId] === 'string') {
          return state.cwdBySession[sessionId]
        }
      }
      return state.lastCwd
    }

    function sessionIdForNode(node) {
      try {
        var holder = node.closest(SESSION_SELECTOR)
        return holder === null ? null : holder.getAttribute('data-conversation-session')
      } catch (error) {
        return null
      }
    }

    function describeFailure(error) {
      if (!error) return t('unknownError')
      var message = error.message || (error.error && error.error.message) || ''
      return message || t('unknownError')
    }

    /** Ask the Host to reveal or open one already-resolved absolute path. */
    function openPath(absolute, mode) {
      var request = mode === 'open' ? { path: absolute } : { path: absolute, action: 'reveal' }
      var call
      try {
        call = ctxRef.remote.session.openWorkspacePath(request)
      } catch (error) {
        showToast('error', t('failed'), describeFailure(error))
        return
      }
      Promise.resolve(call).then(
        function (result) {
          if (result && (result.ok === true || result.opened === true)) {
            showToast('ok', mode === 'open' ? t('opened') : t('revealed'), absolute)
            return
          }
          var message =
            (result && result.error && (result.error.message || result.error.code)) || t('rejected')
          showToast('error', t('failed'), absolute + ' · ' + message)
        },
        function (error) {
          showToast('error', t('failed'), absolute + ' · ' + describeFailure(error))
        },
      )
    }

    function handlePathClick(token, mode, node) {
      var sessionId = sessionIdForNode(node)
      var cwd = cwdForSession(sessionId)
      var absolute = resolveToAbsolute(token, cwd)
      if (absolute === null) {
        showToast('error', t('unresolved'), token)
        return
      }
      if (state.available === false) {
        showToast('error', t('unavailable'), absolute)
        return
      }
      openPath(absolute, mode)
    }

    function onDocumentClick(event) {
      try {
        if (event.defaultPrevented === true) return
        if (event.button !== 0) return
        // Keep the stock modifier gestures: Ctrl/⌘ opens links, Shift extends
        // selection, and the shipped UI already handles them.
        if (event.ctrlKey || event.metaKey || event.shiftKey) return
        if (!isEnabled()) return
        var target = event.target
        if (!target || typeof target.closest !== 'function') return
        if (target.closest(COMPOSER_SELECTOR) !== null) return
        var chat = target.closest(CHAT_SELECTOR)
        if (chat === null) return
        if (hasTextSelection()) return
        var hit = locateCandidate(target)
        if (hit === null) return
        event.preventDefault()
        event.stopPropagation()
        clearHint()
        handlePathClick(hit.token, event.altKey ? 'open' : 'reveal', hit.element)
      } catch (error) {
        try {
          console.warn('[dsh-file-reveal] click handling failed:', error)
        } catch (ignored) {
          // Ignore.
        }
      }
    }

    function onDocumentMouseOver(event) {
      try {
        if (!isEnabled()) {
          clearHint()
          return
        }
        var target = event.target
        if (!target || typeof target.closest !== 'function') {
          clearHint()
          return
        }
        if (target.closest(COMPOSER_SELECTOR) !== null) {
          clearHint()
          return
        }
        if (target.closest(CHAT_SELECTOR) === null) {
          clearHint()
          return
        }
        var hit = locateCandidate(target)
        showHint(hit === null ? null : hit.element)
      } catch (error) {
        clearHint()
      }
    }

    function installStyle() {
      if (document.querySelector('style[' + STYLE_ATTRIBUTE + ']') !== null) return
      styleElement = document.createElement('style')
      styleElement.setAttribute(STYLE_ATTRIBUTE, '')
      styleElement.textContent = STYLE_TEXT
      ;(document.head || document.documentElement).appendChild(styleElement)
    }

    function uninstallStyle() {
      if (styleElement !== null && styleElement.parentNode !== null) {
        styleElement.parentNode.removeChild(styleElement)
      }
      styleElement = null
    }

    // ------------------------------------------------------------------ //
    // Header toggle (also the session-cwd sensor and the visible state)
    // ------------------------------------------------------------------ //

    function FileRevealHeaderAction(props) {
      var enabled = react.useSyncExternalStore(subscribeEnabled, isEnabled, isEnabled)
      var available = react.useSyncExternalStore(subscribeAvailable, getAvailable, getAvailable)
      var sessionId = props && props.sessionId
      var useSessions =
        props && typeof props.useSessions === 'function'
          ? props.useSessions
          : function () {
              return undefined
            }
      var cwd = useSessions(function (snapshot) {
        if (!snapshot || !snapshot.byId || typeof sessionId !== 'string') return undefined
        var row = snapshot.byId[sessionId]
        return row ? row.cwd : undefined
      })

      react.useEffect(
        function () {
          if (typeof cwd === 'string' && cwd.length > 0) {
            state.cwdBySession[sessionId] = cwd
            state.lastCwd = cwd
          }
        },
        [cwd, sessionId],
      )

      react.useEffect(
        function () {
          if (available !== true || enabled !== true || state.hintShown) return
          state.hintShown = true
          writeStored(STORAGE_HINT_SHOWN, '1')
          showToast('ok', t('hintOnce'), '')
        },
        [available, enabled],
      )

      if (available !== true) return null
      var label = enabled ? t('toggleOn') : t('toggleOff')
      return react.createElement(
        'button',
        {
          type: 'button',
          className: enabled ? 'dshfr-toggle' : 'dshfr-toggle dshfr-toggle-off',
          title: label,
          'aria-label': label,
          'aria-pressed': enabled ? 'true' : 'false',
          onClick: function () {
            setEnabled(!enabled)
            clearHint()
          },
        },
        react.createElement(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: 16,
            height: 16,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          react.createElement('path', {
            d: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.2 1.5h4.1A1.6 1.6 0 0 1 13 6.1v4.8a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 10.9Z',
          }),
          react.createElement('path', { d: 'M5.9 9.2h4.2M8.5 7.5l1.7 1.7-1.7 1.7' }),
        ),
      )
    }

    // ------------------------------------------------------------------ //
    // Plugin body
    // ------------------------------------------------------------------ //

    var ctxRef = null
    var installed = false
    var listeners = null

    function probeAvailability() {
      var call
      try {
        call = ctxRef.remote.session.canOpenWorkspacePath()
      } catch (error) {
        setAvailable(false)
        return
      }
      Promise.resolve(call).then(
        function (result) {
          setAvailable(!!(result && (result.value === true || (result.ok === true && result.value !== false))))
        },
        function () {
          setAvailable(false)
        },
      )
    }

    /** Required services: the Session Remote, the Session snapshot store and the slot registry. */
    var inject = ['sessions', 'remote', 'remote.session', 'slots']

    function apply(ctx) {
      ctxRef = ctx
      if (installed) return
      installed = true
      isEnabled()
      installStyle()

      var onOver = function (event) {
        onDocumentMouseOver(event)
      }
      listeners = {
        click: onDocumentClick,
        mouseover: onOver,
      }
      window.document.addEventListener('click', onDocumentClick, true)
      window.document.addEventListener('mouseover', onOver, true)

      // The header entry doubles as the visible on/off control and as a sensor
      // for the current Session's working directory.
      try {
        ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'file-reveal',
              order: 12,
            },
            FileRevealHeaderAction,
          )
        })
      } catch (error) {
        try {
          console.warn('[dsh-file-reveal] header toggle unavailable:', error)
        } catch (ignored) {
          // Ignore.
        }
      }

      probeAvailability()

      ctx.effect(
        function () {
          return function () {
            try {
              if (listeners !== null) {
                window.document.removeEventListener('click', listeners.click, true)
                window.document.removeEventListener('mouseover', listeners.mouseover, true)
                listeners = null
              }
              clearHint()
              timers.forEach(function (id) {
                window.clearTimeout(id)
              })
              timers = []
              if (toastHost !== null && toastHost.parentNode !== null) {
                toastHost.parentNode.removeChild(toastHost)
              }
              toastHost = null
              uninstallStyle()
            } catch (error) {
              // Teardown is best effort; the page owns the remaining nodes.
            }
            installed = false
          }
        },
        'dsh-file-reveal: conversation path clicks',
      )
    }

    exports.name = 'dsh-file-reveal'
    exports.inject = inject
    exports.apply = apply
    // Test seam: the pure rules are exercised by test/parse.test.mjs.
    exports.__test = {
      parsePathToken: parsePathToken,
      resolveToAbsolute: resolveToAbsolute,
      stripWrapping: stripWrapping,
      stripLineSuffix: stripLineSuffix,
      fileUrlToPath: fileUrlToPath,
      baseName: baseName,
      normalizeJoined: normalizeJoined,
      isAbsolutePath: isAbsolutePath,
    }
    return module.exports
  },
})
