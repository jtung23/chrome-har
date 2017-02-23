'use strict';

const {name, version, homepage} = require('./package');

const urlParser = require('url');
const moment = require('moment');
const debug = require('debug')(name);

const {parseRequestCookies, parseResponseCookies} = require('./lib/cookies');
const {calculateRequestHeaderSize, calculateResponseHeaderSize, getHeaderValue, parseHeaders} = require('./lib/headers');

const max = Math.max;

const defaultOptions = {
  includeResourcesFromDiskCache: false
};

const isEmpty = (o) => !o;

function formatMillis(time) {
  return Number(Number(time).toFixed(0));
}

function populateEntryFromResponse(entry, response) {
  const responseHeaders = response.headers;
  const cookieHeader = getHeaderValue(responseHeaders, 'Set-Cookie');

  entry.response = {
    httpVersion: response.protocol,
    redirectURL: '',
    status: response.status,
    statusText: response.statusText,
    content: {
      mimeType: response.mimeType,
      size: 0
    },
    headersSize: -1,
    bodySize: -1,
    cookies: parseResponseCookies(cookieHeader),
    headers: parseHeaders(responseHeaders)
  };

  let locationHeaderValue = getHeaderValue(responseHeaders, 'Location');
  if (locationHeaderValue) {
    entry.response.redirectURL = locationHeaderValue;
  }

  entry.request.httpVersion = response.protocol;

  if (response.fromDiskCache === true) {
    if (isHttp1x(response.protocol)) {
      // In http2 headers are compressed, so calculating size from headers text wouldn't be correct.
      entry.response.headersSize = calculateResponseHeaderSize(response);
    }

    // h2 push might cause resource to be received before parser sees and requests it.
    if (!(response.pushStart > 0)) {
      entry.cache.beforeRequest = {
        lastAccess: '',
        eTag: '',
        hitCount: 0
      }
    }

  } else {
    if (response.requestHeaders) {
      entry.request.headers = parseHeaders(response.requestHeaders);

      const cookieHeader = getHeaderValue(response.requestHeaders, 'Cookie');
      entry.request.cookies = parseRequestCookies(cookieHeader);
    }

    if (isHttp1x(response.protocol)) {
      if (response.headersText) {
        entry.response.headersSize = response.headersText.length;
      } else {
        entry.response.headersSize = calculateResponseHeaderSize(response);
      }

      if (response.requestHeadersText) {
        entry.request.headersSize = response.requestHeadersText.length;
      } else {
        // Since entry.request.httpVersion is now set, we can calculate header size.
        entry.request.headersSize = calculateRequestHeaderSize(entry.request);
      }
    }
  }

  entry.connection = response.connectionId.toString();

  function parseOptionalTime(timing, start, end) {
    if (timing[start] >= 0) {
      return formatMillis(timing[end] - timing[start]);
    }
    return -1;
  }

  let timing = response.timing;
  if (timing) {
    const blocked = formatMillis(firstNonNegative([timing.dnsStart, timing.connectStart, timing.sendStart]));

    const dns = parseOptionalTime(timing, 'dnsStart', 'dnsEnd');
    const connect = parseOptionalTime(timing, 'connectStart', 'connectEnd');
    const send = formatMillis(timing.sendEnd - timing.sendStart);
    const wait = formatMillis(timing.receiveHeadersEnd - timing.sendEnd);
    const receive = 0;

    const ssl = parseOptionalTime(timing, 'sslStart', 'sslEnd');

    entry.timings = {
      blocked,
      dns,
      connect,
      send,
      wait,
      receive,
      ssl
    };

    entry.__requestSentTime = timing.requestTime;
    entry.__receiveHeadersEnd = timing.receiveHeadersEnd;
    if (timing.pushStart > 0) {
      // use the same extended field as WebPageTest
      entry._was_pushed = 1;
    }

    entry.time = max(0, blocked) + max(0, dns) + max(0, connect) + send + wait + receive;

    // Some cached responses generate a Network.requestServedFromCache event,
    // but fromDiskCache is still set to false. For those requestSentDelta will be negative.
    if (!entry.__servedFromCache) {
      // Calculate offset of any connection already in use and add
      // it to the entries startedDateTime(ignore main page request)
      // this seems only be applicable in http1
      if (response.connectionReused && !entry.__mainRequest && isHttp1x(response.protocol)) {
        let requestSentDelta = entry.__requestSentTime - entry.__requestWillBeSentTime;
        let newStartDateTime = entry.__wallTime + requestSentDelta;
        entry.__requestSentDelta = requestSentDelta;
        entry.startedDateTime = moment.unix(newStartDateTime).toISOString();
      }
    }
  } else {
    entry.timings = {
      blocked: -1,
      dns: -1,
      connect: -1,
      send: 0,
      wait: 0,
      receive: 0,
      ssl: -1,
      comment: 'No timings available from Chrome'
    };
    entry.time = 0;
  }
}

module.exports = {
  harFromMessages(messages, options) {
    options = Object.assign({}, defaultOptions, options);

    const ignoredRequests = new Set(),
      rootFrameMappings = new Map();

    let pages = [],
      entries = [],
      currentPageId;

    for (let message of messages) {
      const params = message.params;

      switch (message.method) {
        case 'Page.frameStartedLoading': {
          const frameId = params.frameId;
          let previousFrameId = entries.find((entry) => entry.__frameId === frameId);

          if (rootFrameMappings.has(frameId) || previousFrameId) {
            // This is a sub frame, there's already a page for the root frame
            continue;
          }

          currentPageId = 'page_' + (pages.length + 1);
          let page = {
            id: currentPageId,
            startedDateTime: '',
            title: '',
            pageTimings: {},
            __frameId: frameId
          };
          pages.push(page);
        }
          break;

        case 'Network.requestWillBeSent': {
          if (pages.length < 1) {
            //we haven't loaded any pages yet.
            continue
          }
          const request = params.request;
          if (!isSupportedProtocol(request.url)) {
            ignoredRequests.add(params.requestId);
            continue;
          }
          let frameId = rootFrameMappings.get(params.frameId) || params.frameId;
          let page = pages.find((page) => page.__frameId === frameId);
          if (!page) {
            debug('Request will be sent with requestId ' + params.requestId + ' that can\'t be mapped to any page.');
            continue;
          }

          const cookieHeader = getHeaderValue(request.headers, 'Cookie');

          // Remove fragment, that's what Chrome does.
          const url = urlParser.parse(request.url, true);
          url.hash = null;

          let req = {
            method: request.method,
            url: urlParser.format(url),
            queryString: toNameValuePairs(url.query),
            postData: parsePostData(getHeaderValue(request.headers, 'Content-Type'), request.postData),
            headersSize: -1,
            bodySize: -1, // FIXME calculate based on postData
            cookies: parseRequestCookies(cookieHeader),
            headers: parseHeaders(request.headers)
          };

          let entry = {
            cache: {},
            startedDateTime: moment.unix(params.wallTime).toISOString(), //epoch float64, eg 1440589909.59248
            __requestWillBeSentTime: params.timestamp,
            __wallTime: params.wallTime,
            __requestId: params.requestId,
            __frameId: params.frameId,
            _initialPriority: request.initialPriority,
            _priority: request.initialPriority,
            _initiator: params.initiator.url,
            _initiator_line: params.initiator.lineNumber,
            pageref: currentPageId,
            request: req,
            time: 0
          };

          if (params.redirectResponse) {
            let previousEntry = entries.find((entry) => entry.__requestId === params.requestId);
            if (previousEntry) {
              previousEntry.__requestId += 'r';
              populateEntryFromResponse(previousEntry, params.redirectResponse);
            } else {
              debug('Couldn\'t find original request for redirect response: ' + params.requestId);
            }
          }

          entries.push(entry);

          // this is the first request for this page, so set timestamp of page.
          if (!page.__timestamp) {
            entry.__mainRequest = true;
            page.__wallTime = params.wallTime;
            page.__timestamp = params.timestamp;
            page.startedDateTime = entry.startedDateTime;
            // URL is better than blank, and it's what devtools uses.
            page.title = request.url;
          }
        }
          break;

        case 'Network.requestServedFromCache': {
          if (pages.length < 1) {
            //we haven't loaded any pages yet.
            continue
          }

          if (ignoredRequests.has(params.requestId)) {
            continue;
          }

          let entry = entries.find((entry) => entry.__requestId === params.requestId);
          if (!entry) {
            debug('Received requestServedFromCache for requestId ' + params.requestId + ' with no matching request.');
            continue;
          }

          entry.__servedFromCache = true;
          entry.cache.beforeRequest = {
            lastAccess: '',
            eTag: '',
            hitCount: 0
          }
        }
          break;

        case 'Network.responseReceived': {
          if (pages.length < 1) {
            //we haven't loaded any pages yet.
            continue
          }
          if (ignoredRequests.has(params.requestId)) {
            continue;
          }

          let entry = entries.find((entry) => entry.__requestId === params.requestId);
          if (!entry) {
            debug('Received network response for requestId ' + params.requestId + ' with no matching request.');
            continue;
          }

          try {
            populateEntryFromResponse(entry, params.response);
          } catch (e) {
            debug('Error parsing response: %j', params);
            throw e;
          }
        }
          break;

        case 'Network.dataReceived': {
          if (pages.length < 1) {
            //we haven't loaded any pages yet.
            continue
          }
          if (ignoredRequests.has(params.requestId)) {
            continue;
          }

          let entry = entries.find((entry) => entry.__requestId === params.requestId);
          if (!entry) {
            debug('Received network data for requestId ' + params.requestId + ' with no matching request.');
            continue;
          }

          entry.response.content.size += params.dataLength;
        }
          break;

        case 'Network.loadingFinished': {
          if (pages.length < 1) {
            //we haven't loaded any pages yet.
            continue
          }
          if (ignoredRequests.has(params.requestId)) {
            ignoredRequests.delete(params.requestId);
            continue;
          }

          let entry = entries.find((entry) => entry.__requestId === params.requestId);
          if (!entry) {
            debug('Network loading finished for requestId ' + params.requestId + ' with no matching request.');
            continue;
          }

          const timings = entry.timings;
          timings.receive = formatMillis((params.timestamp - entry.__requestSentTime) * 1000 - entry.__receiveHeadersEnd);
          entry.time = max(0, timings.blocked) + max(0, timings.dns) + max(0, timings.connect) +
            timings.send + timings.wait + timings.receive;

          // FIXME, encodedDataLength includes headers according to https://github.com/cyrus-and/chrome-har-capturer/issues/25
          entry.response.bodySize = params.encodedDataLength > 0 ? params.encodedDataLength : entry.response.bodySize;
          //if (entry.response.headersSize > -1) {
          //  entry.response.bodySize -= entry.response.headersSize;
          //}

          // encodedDataLength will be -1 sometimes
          if (params.encodedDataLength > 0) {
            // encodedDataLength seems to be larger than body size sometimes. Perhaps it's because full packets are
            // listed even though the actual data might be very small.
            // I've seen dataLength: 416, encodedDataLength: 1016,

            const compression = Math.max(0, entry.response.bodySize - params.encodedDataLength);
            if (compression > 0) {
              entry.response.content.compression = compression;
            }
          }
        }
          break;

        case 'Page.loadEventFired': {
          if (pages.length < 1) {
            //we haven't loaded any pages yet.
            continue;
          }

          let page = pages[pages.length - 1];

          if (params.timestamp && page.__timestamp) {
            page.pageTimings.onLoad = formatMillis((params.timestamp - page.__timestamp) * 1000);
          }
        }
          break;

        case 'Page.domContentEventFired': {
          if (pages.length < 1) {
            //we haven't loaded any pages yet.
            continue;
          }

          let page = pages[pages.length - 1];

          if (params.timestamp && page.__timestamp) {
            page.pageTimings.onContentLoad = formatMillis((params.timestamp - page.__timestamp) * 1000);
          }
        }
          break;

        case 'Page.frameAttached': {
          const frameId = params.frameId,
            parentId = params.parentFrameId;

          rootFrameMappings.set(frameId, parentId);

          let grandParentId = rootFrameMappings.get(parentId);
          while (grandParentId) {
            rootFrameMappings.set(frameId, grandParentId);
            grandParentId = rootFrameMappings.get(grandParentId);
          }
        }
          break;

        case 'Page.frameScheduledNavigation':
        case 'Page.frameNavigated':
        case 'Page.frameStoppedLoading':
        case 'Page.frameClearedScheduledNavigation':
        case 'Page.frameDetached':
        case 'Page.frameResized':
          // ignore
          break;

        case 'Page.javascriptDialogOpening':
        case 'Page.javascriptDialogClosed':
        case 'Page.screencastFrame':
        case 'Page.screencastVisibilityChanged':
        case 'Page.colorPicked':
        case 'Page.interstitialShown':
        case 'Page.interstitialHidden':
          // ignore
          break;

        case 'Network.loadingFailed': {
          if (ignoredRequests.has(params.requestId)) {
            ignoredRequests.delete(params.requestId);
            continue;
          }

          let entry = entries.find((entry) => entry.__requestId === params.requestId);
          if (!entry) {
            debug('Network loading failed for requestId ' + params.requestId + ' with no matching request.');
            continue;
          }

          // This could be due to incorrect domain name etc. Sad, but unfortunately not something that a HAR file can
          // represent.
          debug('Failed to load url: ' + entry.request.url);
        }
          break;

        case 'Network.webSocketCreated':
        case 'Network.webSocketFrameSent':
        case 'Network.webSocketFrameError':
        case 'Network.webSocketFrameReceived':
        case 'Network.webSocketClosed':
        case 'Network.webSocketHandshakeResponseReceived':
        case 'Network.webSocketWillSendHandshakeRequest':
          // ignore, sadly HAR file format doesn't include web sockets
          break;

        case 'Network.eventSourceMessageReceived':
          // ignore
          break;
        case 'Network.resourceChangedPriority': {
          let entry = entries.find((entry) => entry.__requestId === params.requestId);

          if (!entry) {
            debug('Received resourceChangedPriority for requestId ' + params.requestId + ' with no matching request.');
            continue;
          }

          entry._priority = message.params.newPriority;

        }
          break;

        default:
          debug('Unhandled event: ' + message.method);
          break;
      }
    }

    if (!options.includeResourcesFromDiskCache) {
      entries = entries.filter((entry) => entry.cache.beforeRequest === undefined);
    }

    const deleteInternalProperties = (o) => {
      // __ properties are only for internal use, _ properties are custom properties for the HAR
      for (let prop in o) {
        if (prop.startsWith('__')) {
          delete o[prop];
        }
      }
      return o;
    };

    entries = entries
      .filter((entry) => {
        if (!entry.response) {
          debug('Dropping incomplete request: ' + entry.request.url);
        }
        return entry.response;
      })
      .map(deleteInternalProperties);

    pages = pages.map(deleteInternalProperties);

    // FIXME sanity check if there are any pages/entries created

    return {
      log: {
        version: '1.2',
        creator: {name, version, comment: homepage},
        pages,
        entries
      }
    }
  }
};

function toNameValuePairs(object) {
  return Object.keys(object)
    .map(key => {
      return {
        name: key,
        value: object[key]
      };
    });
}

function parseUrlEncoded(data) {
  const params = urlParser.parse('?' + data, true).query;
  return toNameValuePairs(params);
}

function parsePostData(contentType, postData) {
  if (isEmpty(contentType) || isEmpty(postData)) {
    return undefined;
  }

  if (/^application\/x-www-form-urlencoded/.test(contentType)) {
    return {
      mimeType: contentType,
      params: parseUrlEncoded(postData)
    };
  } else if (/^application\/json/.test(contentType)) {
    return {
      mimeType: contentType,
      params: toNameValuePairs(JSON.parse(postData))
    };
  } else {
    // FIXME parse multipart/form-data as well.
    return {
      mimeType: contentType,
      text: postData
    };
  }
}

function isSupportedProtocol(url) {
  return /^https?:/.test(url);
}

function isHttp1x(version) {
  return version.toLowerCase().startsWith('http/1.')
}

function firstNonNegative(values) {
  for (let i = 0; i < values.length; ++i) {
    if (values[i] >= 0)
      return values[i];
  }
  return -1;
}