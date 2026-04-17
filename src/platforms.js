function envReady(name) {
  if (name === 'facebook_messenger') {
    return Boolean(process.env.FB_PAGE_ACCESS_TOKEN && process.env.FB_VERIFY_TOKEN);
  }

  if (name === 'generic_webhook') {
    return Boolean(process.env.INTEGRATION_API_KEY);
  }

  return true;
}

function getPlatforms() {
  return [
    {
      name: 'facebook_messenger',
      label: 'Facebook Messenger',
      direction: 'native',
      status: envReady('facebook_messenger') ? 'configured' : 'needs_config',
      notes: 'Native webhook + send API already wired in this project.',
    },
    {
      name: 'facebook_marketplace',
      label: 'Facebook Marketplace',
      direction: 'partial',
      status: 'limited',
      notes: 'Direct personal-profile automation is restricted. Route through Page inbox when possible.',
    },
    {
      name: 'ebay',
      label: 'eBay',
      direction: 'bridge',
      status: 'ready_via_webhook_bridge',
      notes: 'Use automation bridge (Zapier/Make/n8n) to POST inbound messages to generic webhook.',
    },
    {
      name: 'etsy',
      label: 'Etsy',
      direction: 'bridge',
      status: 'ready_via_webhook_bridge',
      notes: 'Use automation bridge for inbound buyer questions and optional outbound handoff.',
    },
    {
      name: 'offerup',
      label: 'OfferUp',
      direction: 'bridge',
      status: 'ready_via_webhook_bridge',
      notes: 'Bridge new message events into the generic inbound endpoint.',
    },
    {
      name: 'mercari',
      label: 'Mercari',
      direction: 'bridge',
      status: 'ready_via_webhook_bridge',
      notes: 'Bridge inbound messages via middleware when direct API access is unavailable.',
    },
    {
      name: 'poshmark',
      label: 'Poshmark',
      direction: 'bridge',
      status: 'ready_via_webhook_bridge',
      notes: 'Bridge inbound events and handle outbound as assisted workflow.',
    },
    {
      name: 'craigslist',
      label: 'Craigslist',
      direction: 'bridge',
      status: 'ready_via_webhook_bridge',
      notes: 'Use email/SMS relay ingestion through middleware into generic webhook.',
    },
    {
      name: 'generic_webhook',
      label: 'Generic Webhook',
      direction: 'universal',
      status: envReady('generic_webhook') ? 'configured' : 'needs_config',
      notes: 'Universal endpoint for any platform that can send HTTP requests.',
    },
  ];
}

module.exports = {
  getPlatforms,
};
