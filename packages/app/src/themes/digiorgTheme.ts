import {
  createUnifiedTheme,
  genPageTheme,
  shapes,
  palettes,
} from '@backstage/theme';

/**
 * DigiOrg Dark Theme
 * Primary: #00d4ff (Cyan), Background: #0a1628 (Deep Navy)
 */
export const digiorgDarkTheme = createUnifiedTheme({
  palette: {
    ...palettes.dark,
    mode: 'dark',
    primary: {
      main: '#00d4ff',
      dark: '#0066aa',
      light: '#33ddff',
      contrastText: '#0a1628',
    },
    secondary: {
      main: '#00a8e8',
      contrastText: '#0a1628',
    },
    background: {
      default: '#0a1628',
      paper: '#0f2035',
    },
    text: {
      primary: '#e8f4fc',
      secondary: '#8aa8c4',
      disabled: '#4a6a8a',
    },
    divider: '#1e3a5f',
    error: {
      main: '#ef5350',
    },
    warning: {
      main: '#ffa726',
    },
    success: {
      main: '#00c853',
    },
    info: {
      main: '#00d4ff',
    },
    navigation: {
      background: '#0f2035',
      indicator: '#00d4ff',
      color: '#8aa8c4',
      selectedColor: '#e8f4fc',
      navItem: {
        hoverBackground: '#1a2d4a',
      },
      submenu: {
        background: '#0a1628',
      },
    },
    tabbar: {
      indicator: '#00d4ff',
    },
    bursts: {
      fontColor: '#e8f4fc',
      slackChannelText: '#8aa8c4',
      backgroundColor: {
        default: '#0f2035',
      },
      gradient: {
        linear: 'linear-gradient(135deg, #00d4ff 0%, #0066aa 100%)',
      },
    },
  },
  defaultPageTheme: 'home',
  fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
  pageTheme: {
    home: genPageTheme({
      colors: ['#00d4ff', '#0066aa'],
      shape: shapes.wave,
      options: { fontColor: '#e8f4fc' },
    }),
    documentation: genPageTheme({
      colors: ['#0099cc', '#0066aa'],
      shape: shapes.wave2,
      options: { fontColor: '#e8f4fc' },
    }),
    tool: genPageTheme({
      colors: ['#00d4ff', '#0099cc'],
      shape: shapes.round,
      options: { fontColor: '#0a1628' },
    }),
    service: genPageTheme({
      colors: ['#0f2035', '#1a2d4a'],
      shape: shapes.wave,
      options: { fontColor: '#e8f4fc' },
    }),
    website: genPageTheme({
      colors: ['#00d4ff', '#0066aa'],
      shape: shapes.wave,
      options: { fontColor: '#e8f4fc' },
    }),
    library: genPageTheme({
      colors: ['#0099cc', '#0f2035'],
      shape: shapes.wave,
      options: { fontColor: '#e8f4fc' },
    }),
    other: genPageTheme({
      colors: ['#0a1628', '#0f2035'],
      shape: shapes.round,
      options: { fontColor: '#e8f4fc' },
    }),
    app: genPageTheme({
      colors: ['#00d4ff', '#0066aa'],
      shape: shapes.wave,
      options: { fontColor: '#0a1628' },
    }),
    apis: genPageTheme({
      colors: ['#0099cc', '#1a2d4a'],
      shape: shapes.wave2,
      options: { fontColor: '#e8f4fc' },
    }),
  },
});

/**
 * DigiOrg Light Theme
 * Primary: #0099cc (Mid-Blue), Background: #f0f4f8 (Light Grey-Blue)
 * Note: Sidebar stays dark for consistent DigiOrg brand identity
 */
export const digiorgLightTheme = createUnifiedTheme({
  palette: {
    ...palettes.light,
    mode: 'light',
    primary: {
      main: '#0099cc',
      dark: '#005588',
      light: '#00d4ff',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#0077aa',
      contrastText: '#ffffff',
    },
    background: {
      default: '#f0f4f8',
      paper: '#ffffff',
    },
    text: {
      primary: '#0a1628',
      secondary: '#3a5068',
      disabled: '#8aa8c4',
    },
    divider: '#c8d4e0',
    error: {
      main: '#c62828',
    },
    warning: {
      main: '#e65100',
    },
    success: {
      main: '#2e7d32',
    },
    info: {
      main: '#0099cc',
    },
    // Keep sidebar dark for brand consistency
    navigation: {
      background: '#0f2035',
      indicator: '#00d4ff',
      color: '#8aa8c4',
      selectedColor: '#e8f4fc',
      navItem: {
        hoverBackground: '#1a2d4a',
      },
      submenu: {
        background: '#0a1628',
      },
    },
    tabbar: {
      indicator: '#0099cc',
    },
    bursts: {
      fontColor: '#ffffff',
      slackChannelText: '#e8f4fc',
      backgroundColor: {
        default: '#0099cc',
      },
      gradient: {
        linear: 'linear-gradient(135deg, #00d4ff 0%, #005588 100%)',
      },
    },
  },
  defaultPageTheme: 'home',
  fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif",
  pageTheme: {
    home: genPageTheme({
      colors: ['#0099cc', '#005588'],
      shape: shapes.wave,
      options: { fontColor: '#ffffff' },
    }),
    documentation: genPageTheme({
      colors: ['#0077aa', '#005588'],
      shape: shapes.wave2,
      options: { fontColor: '#ffffff' },
    }),
    tool: genPageTheme({
      colors: ['#00d4ff', '#0099cc'],
      shape: shapes.round,
      options: { fontColor: '#0a1628' },
    }),
    service: genPageTheme({
      colors: ['#0099cc', '#0066aa'],
      shape: shapes.wave,
      options: { fontColor: '#ffffff' },
    }),
    website: genPageTheme({
      colors: ['#0099cc', '#005588'],
      shape: shapes.wave,
      options: { fontColor: '#ffffff' },
    }),
    library: genPageTheme({
      colors: ['#0077aa', '#005588'],
      shape: shapes.wave,
      options: { fontColor: '#ffffff' },
    }),
    other: genPageTheme({
      colors: ['#f0f4f8', '#e0eaf4'],
      shape: shapes.round,
      options: { fontColor: '#0a1628' },
    }),
    app: genPageTheme({
      colors: ['#00d4ff', '#0099cc'],
      shape: shapes.wave,
      options: { fontColor: '#0a1628' },
    }),
    apis: genPageTheme({
      colors: ['#0099cc', '#0077aa'],
      shape: shapes.wave2,
      options: { fontColor: '#ffffff' },
    }),
  },
});
