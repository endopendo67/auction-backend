// API Configuration
window.API_BASE_URL = window.location.port === '80' 
  ? 'http://localhost:3001'  // Production
  : window.location.origin;  // Development (same origin)

