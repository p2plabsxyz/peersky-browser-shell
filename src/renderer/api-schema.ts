/**
 * API namespaces whose methods and events all go straight to the main
 * process, with no hand-written code in the renderer. Each method `m` of
 * namespace `ns` calls the main process handler `ns.m`, and each event `e` is
 * delivered as `ns.e`. The namespace shows up only for an extension that asks
 * for `permission`, as in Chrome.
 *
 * The hand-written definitions in ./index.ts may share a namespace with an
 * entry here: the entry then adds the calls they do not have.
 */
export interface NamespaceSchema {
  /** Needed to see the namespace; any one of a list will do. */
  permission?: string | string[]
  /** A manifest key the namespace needs, such as 'omnibox'. */
  manifestKey?: string
  /** Contexts that get the namespace; both by default. */
  contexts?: Array<'worker' | 'page'>
  methods?: string[]
  events?: string[]
  /** Calls to take away, which Electron gives but Chrome does not. */
  remove?: string[]
  /** Replace Electron's own bindings of the same names. */
  override?: boolean
}

export const API_SCHEMA: Record<string, NamespaceSchema> = {
  extension: {
    methods: ['setUpdateUrlData'],
  },

  // Electron declares chrome.system.* with nothing behind it; a call crashed
  // the browser process. These replace its bindings.
  'system.cpu': {
    permission: 'system.cpu',
    methods: ['getInfo'],
    override: true,
  },
  'system.memory': {
    permission: 'system.memory',
    methods: ['getInfo'],
    override: true,
  },
  'system.display': {
    permission: 'system.display',
    methods: [
      'getInfo',
      'getDisplayLayout',
      'setDisplayProperties',
      'setDisplayLayout',
      'enableUnifiedDesktop',
      'overscanCalibrationStart',
      'overscanCalibrationAdjust',
      'overscanCalibrationReset',
      'overscanCalibrationComplete',
      'showNativeTouchCalibration',
      'startCustomTouchCalibration',
      'completeCustomTouchCalibration',
      'clearTouchCalibration',
      'setMirrorMode',
    ],
    events: ['onDisplayChanged'],
    override: true,
  },
  'system.storage': {
    permission: 'system.storage',
    methods: ['getInfo', 'ejectDevice', 'getAvailableCapacity'],
    events: ['onAttached', 'onDetached'],
    override: true,
  },
  // Namespaces served entirely by the main process.
  bookmarks: {
    permission: 'bookmarks',
    methods: ['create', 'get', 'getChildren', 'getRecent', 'getSubTree', 'getTree', 'move', 'remove', 'removeTree', 'search', 'update'],
    events: ['onChanged', 'onChildrenReordered', 'onCreated', 'onImportBegan', 'onImportEnded', 'onMoved', 'onRemoved'],
  },
  browsingData: {
    permission: 'browsingData',
    methods: [
      'remove', 'removeAppcache', 'removeCache', 'removeCacheStorage', 'removeCookies', 'removeDownloads',
      'removeFileSystems', 'removeFormData', 'removeHistory', 'removeIndexedDB', 'removeLocalStorage',
      'removePasswords', 'removePluginData', 'removeServiceWorkers', 'removeWebSQL', 'settings',
    ],
  },
  fontSettings: {
    permission: 'fontSettings',
    methods: [
      'clearDefaultFixedFontSize', 'clearDefaultFontSize', 'clearFont', 'clearMinimumFontSize',
      'getDefaultFixedFontSize', 'getDefaultFontSize', 'getFont', 'getFontList', 'getMinimumFontSize',
      'setDefaultFixedFontSize', 'setDefaultFontSize', 'setFont', 'setMinimumFontSize',
    ],
    events: ['onDefaultFixedFontSizeChanged', 'onDefaultFontSizeChanged', 'onFontChanged', 'onMinimumFontSizeChanged'],
  },
  history: {
    permission: 'history',
    methods: ['addUrl', 'deleteAll', 'deleteRange', 'deleteUrl', 'getVisits', 'search'],
    events: ['onVisitRemoved', 'onVisited'],
  },
  readingList: {
    permission: 'readingList',
    methods: ['addEntry', 'query', 'removeEntry', 'updateEntry'],
    events: ['onEntryAdded', 'onEntryRemoved', 'onEntryUpdated'],
  },
  search: {
    permission: 'search',
    methods: ['query'],
  },
  sessions: {
    permission: 'sessions',
    methods: ['getDevices', 'getRecentlyClosed', 'restore'],
    events: ['onChanged'],
  },
  tabGroups: {
    permission: 'tabGroups',
    methods: ['get', 'move', 'query', 'update'],
    events: ['onCreated', 'onMoved', 'onRemoved', 'onUpdated'],
  },
  tabs: {
    methods: ['discard', 'group', 'ungroup', 'detectLanguage'],
  },
  omnibox: {
    manifestKey: 'omnibox',
    methods: ['sendSuggestions', 'setDefaultSuggestion'],
    events: ['onActionExecuted', 'onDeleteSuggestion', 'onInputCancelled', 'onInputChanged', 'onInputEntered', 'onInputStarted'],
  },
}
