// The ONLY setting in the website. This is your Cloudflare Worker address, not your Apps Script URL.
// It is fine for this to be public: the Worker accepts only two locked-down requests from this site.
// The organization is NOT set here: each organization's link carries its own secret token (?t=...).
window.PORTAL_CONFIG = {
  api: 'https://church-register.seamiragu.workers.dev/'
};
