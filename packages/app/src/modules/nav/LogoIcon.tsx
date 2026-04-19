/**
 * DigiOrg Icon Logo — shown in the sidebar when collapsed
 * Compact round DigiOrg logo
 */
export const LogoIcon = () => {
  return (
    <img
      src="/digiorg-logo.png"
      alt="DigiOrg"
      style={{
        height: 32,
        width: 32,
        borderRadius: '50%',
        objectFit: 'cover',
        border: '1.5px solid #00d4ff',
      }}
    />
  );
};
