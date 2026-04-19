/**
 * DigiOrg Full Logo — shown in the sidebar when expanded
 * Uses the DigiOrg logo PNG + "DigiOrg Platform" wordmark
 */
export const LogoFull = () => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '0 4px',
      }}
    >
      <img
        src="/digiorg-logo.png"
        alt="DigiOrg"
        style={{
          height: 32,
          width: 32,
          borderRadius: '50%',
          objectFit: 'cover',
          border: '1.5px solid #00d4ff',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          color: '#e8f4fc',
          fontWeight: 600,
          fontSize: '0.95rem',
          letterSpacing: '-0.3px',
          fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
          whiteSpace: 'nowrap',
        }}
      >
        DigiOrg Platform
      </span>
    </div>
  );
};
