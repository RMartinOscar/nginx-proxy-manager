const https         = require('https');
const fs            = require('fs');
const logger        = require('../logger').ip_ranges;
const error         = require('../lib/error');
const utils         = require('../lib/utils');
const internalNginx = require('./nginx');

const CLOUDFRONT_URL   = 'https://ip-ranges.amazonaws.com/ip-ranges.json';
const CLOUDFARE_URL    = 'https://api.cloudflare.com/client/v4/ips';

const regIpV4 = /^(\d+\.?){4}\/\d+/;
const regIpV6 = /^(([\da-fA-F]+)?:)+\/\d+/;

const internalIpRanges = {

	interval_timeout:    1000 * 60 * 60 * 6, // 6 hours
	interval:            null,
	interval_processing: false,
	iteration_count:     0,

	initTimer: () => {
		logger.info('IP Ranges Renewal Timer initialized');
		internalIpRanges.interval = setInterval(internalIpRanges.fetch, internalIpRanges.interval_timeout);
	},

	fetchUrl: (url) => {
		return new Promise((resolve, reject) => {
			logger.info('Fetching ' + url);
			return https.get(url, (res) => {
				res.setEncoding('utf8');
				let raw_data = '';
				res.on('data', (chunk) => {
					raw_data += chunk;
				});

				res.on('end', () => {
					resolve(raw_data);
				});
			}).on('error', (err) => {
				reject(err);
			});
		});
	},

	/**
	 * Triggered at startup and then later by a timer, this will fetch the ip ranges from services and apply them to nginx.
	 */
	fetch: () => {
		if (!internalIpRanges.interval_processing) {
			internalIpRanges.interval_processing = true;
			logger.info('Fetching IP Ranges from online services...');

			let ip_ranges = [];

			return internalIpRanges.fetchUrl(CLOUDFRONT_URL)
				.then((cloudfront_data) => {
					let data = JSON.parse(cloudfront_data);

					if (data && typeof data.prefixes !== 'undefined') {
						ip_ranges = ip_ranges.filter(t => !data.prefixes.includes(t)).concat(data.prefixes.filter(p => p.service === 'CLOUDFRONT'))
					}

					if (data && typeof data.ipv6_prefixes !== 'undefined') {
						ip_ranges = ip_ranges.filter(t => !data.ipv6_prefixes.includes(t)).concat(data.ipv6_prefixes.filter(p => p.service === 'CLOUDFRONT'))
					}
				})
				.then(() => {
					return internalIpRanges.fetchUrl(CLOUDFARE_URL);
				})
				.then((cloudfare_data) => {
					let data = JSON.parse(cloudfare_data);

					if (data && typeof data.ipv4_cidrs !== 'undefined') {
						ip_ranges = ip_ranges.filter(t => !data.ipv4_cidrs.includes(t)).concat(data.ipv4_cidrs)
					}

					if (data && typeof data.ipv6_cidrs !== 'undefined') {
						ip_ranges = ip_ranges.filter(t => !data.ipv6_cidrs.includes(t)).concat(data.ipv6_cidrs)
					}
				})
				.then(() => {
					let clean_ip_ranges = [];
					ip_ranges.map((range) => {
						if (range) {
							clean_ip_ranges.push(range);
						}
					});

					return internalIpRanges.generateConfig(clean_ip_ranges)
						.then(() => {
							if (internalIpRanges.iteration_count) {
								// Reload nginx
								return internalNginx.reload();
							}
						});
				})
				.then(() => {
					internalIpRanges.interval_processing = false;
					internalIpRanges.iteration_count++;
				})
				.catch((err) => {
					logger.error(err.message);
					internalIpRanges.interval_processing = false;
				});
		}
	},

	/**
	 * @param   {Array}  ip_ranges
	 * @returns {Promise}
	 */
	generateConfig: (ip_ranges) => {
		const renderEngine = utils.getRenderEngine();
		return new Promise((resolve, reject) => {
			let template = null;
			let filename = '/etc/nginx/conf.d/include/ip_ranges.conf';
			try {
				template = fs.readFileSync(__dirname + '/../templates/ip_ranges.conf', {encoding: 'utf8'});
			} catch (err) {
				reject(new error.ConfigurationError(err.message));
				return;
			}

			renderEngine
				.parseAndRender(template, {ip_ranges: ip_ranges})
				.then((config_text) => {
					fs.writeFileSync(filename, config_text, {encoding: 'utf8'});
					resolve(true);
				})
				.catch((err) => {
					logger.warn('Could not write ' + filename + ':', err.message);
					reject(new error.ConfigurationError(err.message));
				});
		});
	}
};

module.exports = internalIpRanges;
