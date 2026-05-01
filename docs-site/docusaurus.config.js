const config = {
  title: 'ADO Sync Documentation',
  tagline: 'Docs for syncing local test specs with Azure DevOps Test Cases.',
  favicon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>A</text></svg>',
  url: process.env.DOCS_SITE_URL || 'https://ado-sync.pages.dev',
  baseUrl: '/',
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn'
    }
  },
  organizationName: 'PavanMudigonda',
  projectName: 'ado-sync',
  trailingSlash: false,
  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: require.resolve('./sidebars.js'),
          editUrl: 'https://github.com/PavanMudigonda/ado-sync/tree/main/docs-site/'
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css')
        }
      }
    ]
  ],
  themeConfig: {
    navbar: {
      title: 'ADO Sync',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Documentation'
        },
        {
          href: 'https://github.com/PavanMudigonda/ado-sync',
          label: 'GitHub',
          position: 'right'
        },
        {
          href: 'https://www.npmjs.com/package/ado-sync',
          label: 'npm',
          position: 'right'
        }
      ]
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'CLI', to: '/cli' },
            { label: 'Configuration', to: '/configuration' },
            { label: 'MCP Server', to: '/mcp-server' }
          ]
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: 'https://github.com/PavanMudigonda/ado-sync' },
            { label: 'VS Code Extension', to: '/vscode-extension' }
          ]
        }
      ],
      copyright: `Copyright ${new Date().getFullYear()} ado-sync contributors.`
    },
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true
    }
  }
};

module.exports = config;
