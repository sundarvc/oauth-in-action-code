var express = require("express");
var url = require("url");
var bodyParser = require('body-parser');
var randomstring = require("randomstring");
var cons = require('consolidate');
var nosql = require('nosql').load('database.nosql');
var querystring = require('querystring');
var __ = require('underscore');
__.string = require('underscore.string');
var base64url = require('base64url');
var jose = require('./lib/jsrsasign.js');

var app = express();

app.use(bodyParser.urlencoded({ extended: true })); // support form-encoded bodies (for the token endpoint)

app.engine('html', cons.underscore);
app.set('view engine', 'html');
app.set('views', 'files/authorizationServer');
app.set('json spaces', 4);

// authorization server information
var authServer = {
	authorizationEndpoint: 'http://localhost:9001/authorize',
	tokenEndpoint: 'http://localhost:9001/token'
};

// client information
var clients = [
	{
		"client_id": "oauth-client-1",
		"client_secret": "oauth-client-secret-1",
		"redirect_uri": "http://localhost:9000/callback",
		"scope": ["movies", "foods", "music"]
	},
	{
		"client_id": "oauth-client-2",
		"client_secret": "oauth-client-secret-1",
		"redirect_uri": "http://localhost:9000/callback",
		"scope": ["bar"]
	}
];

var sharedTokenSecret = "shared token secret!";

var rsaKey = {
  "alg": "RS256",
  "d": "ZXFizvaQ0RzWRbMExStaS_-yVnjtSQ9YslYQF1kkuIoTwFuiEQ2OywBfuyXhTvVQxIiJqPNnUyZR6kXAhyj__wS_Px1EH8zv7BHVt1N5TjJGlubt1dhAFCZQmgz0D-PfmATdf6KLL4HIijGrE8iYOPYIPF_FL8ddaxx5rsziRRnkRMX_fIHxuSQVCe401hSS3QBZOgwVdWEb1JuODT7KUk7xPpMTw5RYCeUoCYTRQ_KO8_NQMURi3GLvbgQGQgk7fmDcug3MwutmWbpe58GoSCkmExUS0U-KEkHtFiC8L6fN2jXh1whPeRCa9eoIK8nsIY05gnLKxXTn5-aPQzSy6Q",
  "e": "AQAB",
  "n": "p8eP5gL1H_H9UNzCuQS-vNRVz3NWxZTHYk1tG9VpkfFjWNKG3MFTNZJ1l5g_COMm2_2i_YhQNH8MJ_nQ4exKMXrWJB4tyVZohovUxfw-eLgu1XQ8oYcVYW8ym6Um-BkqwwWL6CXZ70X81YyIMrnsGTyTV6M8gBPun8g2L8KbDbXR1lDfOOWiZ2ss1CRLrmNM-GRp3Gj-ECG7_3Nx9n_s5to2ZtwJ1GS1maGjrSZ9GRAYLrHhndrL_8ie_9DS2T-ML7QNQtNkg2RvLv4f0dpjRYI23djxVtAylYK4oiT_uEMgSkc4dxwKwGuBxSO0g9JOobgfy0--FUHHYtRi0dOFZw",
  "kty": "RSA",
  "kid": "authserver"
};

var protectedResources = [
	{
		"resource_id": "protected-resource-1",
		"resource_secret": "protected-resource-secret-1"
	}
];

var codes = {};

var requests = {};

var getClient = function(clientId) {
	return __.find(clients, function(client) { return client.client_id == clientId; });
};

var getProtectedResource = function(resourceId) {
	return __.find(protectedResources, function(resource) { return resource.resource_id == resourceId; });
};

app.get('/', function(req, res) {
	res.render('index', {clients: clients, authServer: authServer});
});

app.get("/authorize", function(req, res){
	
	var client = getClient(req.query.client_id);
	
	if (!client) {
		console.log('Unknown client %s', req.query.client_id);
		res.render('error', {error: 'Unknown client'});
		return;
	} else if (req.query.redirect_uri != client.redirect_uri) {
		console.log('Mismatched redirect URI, expected %s got %s', client.redirect_uri, req.query.redirect_uri);
		res.render('error', {error: 'Invalid redirect URI'});
		return;
	} else {
		
		var scope = req.query.scope ? req.query.scope.split(' ') : undefined;
		if (__.difference(scope, client.scope).length > 0) {
			// client asked for a scope it couldn't have
			var urlParsed =url.parse(client.redirect_uri);
			delete urlParsed.search; // this is a weird behavior of the URL library
			urlParsed.query = urlParsed.query || {};
			urlParsed.query.error = 'invalid_scope';
			res.redirect(url.format(urlParsed));
			return;
		}
		
		var reqid = randomstring.generate(8);
		
		requests[reqid] = req.query;
		
		res.render('approve', {client: client, reqid: reqid, scope: scope});
		return;
	}

});

app.post('/approve', function(req, res) {

	var reqid = req.body.reqid;
	var query = requests[reqid];
	delete requests[reqid];

	if (!query) {
		// there was no matching saved request, this is an error
		res.render('error', {error: 'No matching authorization request'});
		return;
	}
	
	if (req.body.approve) {
		if (query.response_type == 'code') {
			// user approved access
			var code = randomstring.generate(8);
			
			var user = req.body.user;
		
			var scope = __.filter(__.keys(req.body), function(s) { return __.string.startsWith(s, 'scope_'); })
				.map(function(s) { return s.slice('scope_'.length); });
			var client = getClient(query.client_id);
			if (__.difference(scope, client.scope).length > 0) {
				// client asked for a scope it couldn't have
				var urlParsed =url.parse(client.redirect_uri);
				delete urlParsed.search; // this is a weird behavior of the URL library
				urlParsed.query = urlParsed.query || {};
				urlParsed.query.error = 'invalid_scope';
				res.redirect(url.format(urlParsed));
				return;
			}

			// save the code and request for later
			codes[code] = { authorizationEndpointRequest: query, scope: scope, user: user };
		
			var urlParsed =url.parse(query.redirect_uri);
			delete urlParsed.search; // this is a weird behavior of the URL library
			urlParsed.query = urlParsed.query || {};
			urlParsed.query.code = code;
			urlParsed.query.state = query.state; 
			res.redirect(url.format(urlParsed));
			return;
		} else {
			// we got a response type we don't understand
			var urlParsed =url.parse(query.redirect_uri);
			delete urlParsed.search; // this is a weird behavior of the URL library
			urlParsed.query = urlParsed.query || {};
			urlParsed.query.error = 'unsupported_response_type';
			res.redirect(url.format(urlParsed));
			return;
		}
	} else {
		// user denied access
		var urlParsed =url.parse(query.redirect_uri);
		delete urlParsed.search; // this is a weird behavior of the URL library
		urlParsed.query = urlParsed.query || {};
		urlParsed.query.error = 'access_denied';
		res.redirect(url.format(urlParsed));
		return;
	}
	
});

app.post("/token", function(req, res){
	
	var auth = req.headers['authorization'];
	if (auth) {
		// check the auth header
		var clientCredentials = new Buffer(auth.slice('basic '.length), 'base64').toString().split(':');
		var clientId = querystring.unescape(clientCredentials[0]);
		var clientSecret = querystring.unescape(clientCredentials[1]);
	}
	
	// otherwise, check the post body
	if (req.body.client_id) {
		if (clientId) {
			// if we've already seen the client's credentials in the authorization header, this is an error
			console.log('Client attempted to authenticate with multiple methods');
			res.status(401).json({error: 'invalid_client'});
			return;
		}
		
		var clientId = req.body.client_id;
		var clientSecret = req.body.client_secret;
	}
	
	var client = getClient(clientId);
	if (!client) {
		console.log('Unknown client %s', clientId);
		res.status(401).json({error: 'invalid_client'});
		return;
	}
	
	if (client.client_secret != clientSecret) {
		console.log('Mismatched client secret, expected %s got %s', client.client_secret, clientSecret);
		res.status(401).json({error: 'invalid_client'});
		return;
	}
	
	if (req.body.grant_type == 'authorization_code') {
		
		var code = codes[req.body.code];
		
		if (code) {
			delete codes[req.body.code]; // burn our code, it's been used
			if (code.authorizationEndpointRequest.client_id == clientId) {
				//var access_token = randomstring.generate();
				var header = { 'typ': 'JWT', 'alg': 'RS256', 'kid': 'authserver'};
				
				var refresh_token = randomstring.generate();
				var payload = {};
				payload.iss = 'http://localhost:9001/';
				payload.sub = code.user;
				payload.aud = 'http://localhost:9002/';
				payload.iat = Math.floor(Date.now() / 1000);
				payload.exp = Math.floor(Date.now() / 1000) + (5 * 60);
				payload.jti = randomstring.generate();
				console.log(payload);
				
				var stringHeader = JSON.stringify(header);
				var stringPayload = JSON.stringify(payload);
				//var encodedHeader = base64url.encode(JSON.stringify(header));
				//var encodedPayload = base64url.encode(JSON.stringify(payload));
				
				//var access_token = encodedHeader + '.' + encodedPayload + '.';
				//var access_token = jose.jws.JWS.sign('HS256', stringHeader, stringPayload, new Buffer(sharedTokenSecret).toString('hex'));
				var privateKey = jose.KEYUTIL.getKey(rsaKey);
				var access_token = jose.jws.JWS.sign('RS256', stringHeader, stringPayload, privateKey);

				nosql.insert({ access_token: access_token, client_id: clientId, scope: code.scope, user: code.user });
				nosql.insert({ refresh_token: refresh_token, client_id: clientId, scope: code.scope, user: code.user });

				console.log('Issuing access token %s and refresh token %s with scope %s for code %s', access_token, refresh_token, code.scope, req.body.code);

				var token_response = { access_token: access_token, token_type: 'Bearer',  refresh_token: refresh_token, scope: code.scope.join(' ') };
				res.status(200).json(token_response);
				return;
			} else {
				console.log('Client mismatch, expected %s got %s', code.authorizationEndpointRequest.client_id, clientId);
				res.status(400).json({error: 'invalid_grant'});
				return;
			}
		} else {
			console.log('Unknown code, %s', req.body.code);
			res.status(400).json({error: 'invalid_grant'});
			return;
		}
	} else if (req.body.grant_type == 'refresh_token') {
		nosql.all(function(token) {
			return (token.refresh_token == req.body.refresh_token);
		}, function(err, tokens) {
			if (tokens.length == 1) {
				var token = tokens[0];
				if (token.clientId != clientId) {
					console.log('Invalid client using a refresh token, expected %s got %s', token.clientId, clientId);
					nosql.remove(function(found) { return (found == token); }, function () {} );
					res.status(400).end();
					return
				}
				console.log("We found a matching token: %s", req.body.refresh_token);
				var access_token = randomstring.generate();
				var token_response = { access_token: access_token, token_type: 'Bearer',  refresh_token: refresh_token };
				nosql.insert({ access_token: access_token, client_id: clientId });
				console.log('Issuing access token %s for refresh token %s', access_token, req.body.refresh_token);
				res.status(200).json(token_response);
				return;
			} else {
				console.log('No matching token was found.');
				res.status(401).end();
			}
		});
	} else {
		console.log('Unknown grant type %s', req.body.grant_type);
		res.status(400).json({error: 'unsupported_grant_type'});
	}
});

app.post('/revoke', function(req, res) {
	var auth = req.headers['authorization'];
	if (auth) {
		// check the auth header
		var clientCredentials = new Buffer(auth.slice('basic '.length), 'base64').toString().split(':');
		var clientId = querystring.unescape(clientCredentials[0]);
		var clientSecret = querystring.unescape(clientCredentials[1]);
	}
	
	// otherwise, check the post body
	if (req.body.client_id) {
		if (clientId) {
			// if we've already seen the client's credentials in the authorization header, this is an error
			console.log('Client attempted to authenticate with multiple methods');
			res.status(401).json({error: 'invalid_client'});
			return;
		}
		
		var clientId = req.body.client_id;
		var clientSecret = req.body.client_secret;
	}
	
	var client = getClient(clientId);
	if (!client) {
		console.log('Unknown client %s', clientId);
		res.status(401).json({error: 'invalid_client'});
		return;
	}
	
	if (client.client_secret != clientSecret) {
		console.log('Mismatched client secret, expected %s got %s', client.client_secret, clientSecret);
		res.status(401).json({error: 'invalid_client'});
		return;
	}
	
	var inToken = req.body.token;
	nosql.remove(function(token) {
		if (token.access_token == inToken && token.client_id == clientId) {
			return true;	
		}
	}, function(err, count) {
		console.log("Removed %s tokens", count);
		res.status(201).end();
		return;
	});
	
});

app.post('/introspect', function(req, res) {
	var auth = req.headers['authorization'];
	var resourceCredentials = new Buffer(auth.slice('basic '.length), 'base64').toString().split(':');
	var resourceId = querystring.unescape(resourceCredentials[0]);
	var resourceSecret = querystring.unescape(resourceCredentials[1]);

	var resource = getProtectedResource(resourceId);
	if (!resource) {
		console.log('Unknown resource %s', resourceId);
		res.status(401).end();
		return;
	}
	
	if (resource.resource_secret != resourceSecret) {
		console.log('Mismatched secret, expected %s got %s', resource.resource_secret, resourceSecret);
		res.status(401).end();
		return;
	}
	
	var inToken = req.body.token;
	console.log('Introspecting token %s', inToken);
	nosql.one(function(token) {
		if (token.access_token == inToken) {
			return token;	
		}
	}, function(err, token) {
		if (token) {
			console.log("We found a matching token: %s", inToken);
			
			var introspectionResponse = {};
			introspectionResponse.active = true;
			introspectionResponse.iss = 'http://localhost:9001/';
			introspectionResponse.sub = token.user;
			introspectionResponse.scope = token.scope.join(' ');
			introspectionResponse.client_id = token.client_id;
						
			res.status(200).json(introspectionResponse);
			return;
		} else {
			console.log('No matching token was found.');

			var introspectionResponse = {};
			introspectionResponse.active = false;
			res.status(200).json(introspectionResponse);
			return;
		}
	});
	
	
});

app.use('/', express.static('files/authorizationServer'));

// clear the database
nosql.clear();

var server = app.listen(9001, 'localhost', function () {
  var host = server.address().address;
  var port = server.address().port;

  console.log('OAuth Authorization Server is listening at http://%s:%s', host, port);
});
 
