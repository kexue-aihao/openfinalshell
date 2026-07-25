export default {
  translation: {
    app: {
      name: 'OpenFinalShell'
    },
    activity: {
      connections: 'Connections',
      snippets: 'Snippets',
      forwards: 'Port forwarding',
      transfers: 'Transfers',
      settings: 'Settings',
      toggleTheme: 'Toggle theme'
    },
    welcome: {
      title: 'OpenFinalShell',
      subtitle: 'Open-source FinalShell — SSH terminal · SFTP · server monitor',
      newConnection: 'New connection',
      newConnectionDesc: 'Configure host and authentication, save to the tree',
      quickConnect: 'Quick connect',
      quickConnectPlaceholder: 'ssh user@host[:port]',
      recent: 'Recent sessions',
      noRecent: 'No recent sessions'
    },
    sidebar: {
      connections: 'Connections',
      snippets: 'Snippets',
      forwards: 'Port forwarding',
      transfers: 'Transfers',
      searchPlaceholder: 'Search name or host…',
      emptyConnections: 'No connections yet. Click + to create one.',
      emptySnippets: 'No snippets yet',
      emptyForwards: 'No forwarding rules yet',
      emptyTransfers: 'No transfer tasks',
      newConnection: 'New connection',
      newGroup: 'New group'
    },
    status: {
      notConnected: 'Not connected',
      version: 'Version'
    },
    terminal: {
      connecting: 'Connecting to {{target}}…',
      disconnected: 'Disconnected',
      reconnect: 'Reconnect',
      multilinePasteTitle: 'Paste multiple lines?',
      multilinePasteContent:
        'Clipboard contains {{lines}} lines which may execute immediately. Paste anyway?'
    },
    prompt: {
      hostkeyNewTitle: 'First connection: verify host fingerprint',
      hostkeyChangedTitle: 'WARNING: host key changed!',
      hostkeyChangedWarning:
        'The remote host key does not match the recorded one — possible man-in-the-middle attack. Disconnect unless you know the server was reinstalled!',
      hostkeyTarget: 'Host',
      hostkeyPrevious: 'Previously recorded fingerprint',
      trustOnce: 'This time only',
      trustAlways: 'Trust and save',
      trustNew: 'Replace and trust',
      passwordTitle: 'Password for {{target}}',
      passwordPlaceholder: 'SSH login password',
      rememberPassword: 'Remember password (encrypted)',
      kbiTitle: 'Additional authentication required'
    },
    conn: {
      connect: 'Connect',
      duplicate: 'Duplicate',
      copySshCommand: 'Copy SSH command',
      copied: 'Copied to clipboard',
      deleted: 'Deleted',
      saved: 'Saved',
      deleteConfirm: 'Delete connection "{{name}}"?',
      discardChanges: 'Discard unsaved changes?',
      editTitle: 'Edit: {{name}}',
      groupNamePlaceholder: 'Group name',
      name: 'Name',
      nameRequired: 'Please enter a name',
      namePlaceholder: 'e.g. prod web-01',
      host: 'Host',
      hostRequired: 'Please enter a host',
      port: 'Port',
      username: 'Username',
      usernameRequired: 'Please enter a username',
      authMethod: 'Authentication',
      authPassword: 'Password',
      authPrivateKey: 'Private key',
      password: 'Password',
      passwordSavedHint: 'Encrypted password saved; leave empty to keep it',
      passwordEmptyHint: 'Leave empty to be asked on connect',
      privateKeyPath: 'Private key file',
      privateKeyRequired: 'Please choose a private key file',
      pickPrivateKey: 'Choose private key file',
      browse: 'Browse',
      passphrase: 'Key passphrase',
      group: 'Group',
      noGroup: 'No group',
      color: 'Label color',
      advanced: 'Advanced (terminal / network)',
      charset: 'Encoding',
      termType: 'Terminal type',
      startupCommand: 'Run after login',
      startupCommandPlaceholder: 'Command to run automatically after connect',
      keepalive: 'Keepalive',
      timeout: 'Timeout',
      legacyAlgorithms: 'Legacy algorithms',
      legacyAlgorithmsTip:
        'Append ssh-rsa, dh-group14-sha1, aes128-cbc etc. for old switches/bastions',
      compress: 'Compression',
      note: 'Note'
    },
    common: {
      ok: 'OK',
      cancel: 'Cancel',
      save: 'Save',
      delete: 'Delete',
      edit: 'Edit',
      rename: 'Rename',
      close: 'Close',
      retry: 'Retry',
      loadFailed: 'Failed to load',
      panelCrashed: 'This panel crashed',
      reload: 'Reload'
    }
  }
} as const
