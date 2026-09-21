// Configuração pública do painel. Estes dois valores NÃO são secretos:
// eles aparecem em Supabase > Project Settings > API.
// NUNCA coloque aqui a chave "service_role" (essa é secreta e vai só no Netlify).
window.BEE_CONFIG = {
  SUPABASE_URL: "https://edatvkbzegxoyxpubezg.supabase.co",      // ex.: https://abcdefgh.supabase.co
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkYXR2a2J6ZWd4b3l4cHViZXpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5NDkzMjMsImV4cCI6MjEwNTUyNTMyM30.kCXIk1Pk0A41vxdu8JWHlZMPeNGDIVqzabq77Seocm0"   // começa com eyJ...
};
 