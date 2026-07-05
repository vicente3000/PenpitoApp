const basePalette = {
  background: '#f8fafc',
  surface: '#ffffff',
  surfaceHighlight: '#f1f5f9',
  border: '#e2e8f0',
  borderHighlight: '#d97706',
  primary: '#d97706',
  primaryGlow: 'rgba(217, 119, 6, 0.08)',
  secondary: '#f59e0b',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
  text: '#0f172a',
  textMuted: '#64748b',
  tint: '#d97706',
  tabIconDefault: '#64748b',
  tabIconSelected: '#d97706',
};

export const Colors = {
  ...basePalette,
  light: {
    ...basePalette,
  },
  dark: {
    ...basePalette,
    text: '#ffffff',
    background: '#0f172a',
    tint: '#f59e0b',
    tabIconDefault: '#64748b',
    tabIconSelected: '#f59e0b',
  },
};

export default Colors;

export const Shadows = {
  glowPrimary: {
    shadowColor: '#d97706',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 2,
  },
  glowSecondary: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  glass: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
};
