import http from "http"
import https from "https"
import path from "path"
import express from "express"
import compression from "compression"
import bodyParser from "body-parser"
import helmet from "helmet"
import WebpackDevMiddleware from "webpack-dev-middleware"
import WebpackHotMiddleware from "webpack-hot-middleware"
import compileClient from "../compileClient"
import handleCompilationErrors from "../handleCompilationErrors";
import reactServer from "../react-server";
import setupLogging from "../setupLogging";
import logProductionWarnings from "../logProductionWarnings";
import expressState from 'express-state';
import cookieParser from 'cookie-parser';
import fs from 'fs';

const logger = reactServer.logging.getLogger(__LOGGER__);

const serverToStopPromise = (httpServer, webpackDevMiddlewareInstance) => {

	const sockets = [];

		httpServer.on('connection', socket => sockets.push(socket));
	}

	return () => {
		return new Promise((resolve, reject) => {

			sockets.forEach(socket => socket.destroy());

			if (webpackDevMiddlewareInstance) {
				webpackDevMiddlewareInstance.close();
			}

			httpServer.on('error', (e) => {
				logger.error('An error was emitted while shutting down the server');
				logger.error(e);
				reject(e);
			});
			httpServer.close((e) => {
				if (e) {
					logger.error('The server was not started, so it cannot be stopped.');
					logger.error(e);
					reject(e);
					return;
				}
				resolve();
			});
		});
	};
};

const startServer = (serverRoutes, options, compiler, config) => {
	const {
		port,
		bindIp,
		httpsOptions,
		customMiddlewarePath,
		hot,
		longTermCaching,
	} = options;

	let webpackDevMiddlewareInstance;
	const server = express();

	if (hot) {
		logger.notice("Enabling hot module reload with webpack-dev-middleware");
		webpackDevMiddlewareInstance = WebpackDevMiddleware(compiler, {
			noInfo: true,
			lazy: false,
			publicPath: config.output.publicPath,
			log: logger.debug,
			warn: logger.warn,
			error: logger.error,
		});
		server.use(webpackDevMiddlewareInstance);
		server.use(WebpackHotMiddleware(compiler, {
			log: logger.debug,
			overlay: false,
			path: '/__react_server_hmr__',
		}));
	} else {
		if (compiler) {
			logger.notice("Compiling Webpack bundle prior to starting server");
			compiler.run((err, stats) => {
				handleCompilationErrors(err, stats);
			});
		}

		server.use('/', compression(), express.static(`__clientTemp/build`, {
			maxage: longTermCaching ? '365d' : '0s',
		}));
	}

	let middlewareSetup = (server, rsMiddleware) => {
		server.use(compression());
		server.use(bodyParser.urlencoded({ extended: false }));
		server.use(bodyParser.json());
		server.use(helmet());
		rsMiddleware();
	};

	const httpServer = httpsOptions ? https.createServer(httpsOptions, server) : http.createServer(server);
	return {
		stop: serverToStopPromise(httpServer, webpackDevMiddlewareInstance),
		started: new Promise((resolve, reject) => {
			serverRoutes.then((serverRoutesFile) => {
				logger.info("Starting react-server...");

				let rsMiddlewareCalled = false;
				const rsMiddleware = () => {
					rsMiddlewareCalled = true;

					expressState.extend(server);

					server.use(cookieParser());

				
					server.set('state namespace', '__reactServerState');

					server.use((req, res, next) => {
						reactServer.middleware(req, res, next, require(serverRoutesFile));
					});
				};

				if (customMiddlewarePath) {
					const customMiddlewareDirAb = path.resolve(process.cwd(), customMiddlewarePath);
					middlewareSetup = require(customMiddlewareDirAb).default;
				}

				middlewareSetup(server, rsMiddleware);

				if (!rsMiddlewareCalled) {
					logger.error("Error react-server middleware was never setup in custom middleware function");
					reject("Custom middleware did not setup react-server middleware");
					return;
				}

				httpServer.on('error', (e) => {
					logger.error("Error starting up react-server");
					logger.error(e);
					reject(e);
				});
				httpServer.listen(port, bindIp, (e) => {
					if (e) {
						reject(e);
						return;
					}
					logger.info(`Started react-server over ${httpsOptions ? "HTTPS" : "HTTP"} on ${bindIp}:${port}`);
					resolve();
				});
			});
		}),
	};
};


export default function start(options) {
	setupLogging(options);
	logProductionWarnings(options);

	const {
		port,
		bindIp,
		compileOnStartup,
		hot,
	} = options;

	const routesFileLocation = path.join(process.cwd(), '__clientTemp/routes_server.js');
	let serverRoutes,
		compiler,
		config;

	if ((hot === false || hot === "false") && (compileOnStartup === false || compileOnStartup === "false")) {
		logger.debug('Not running the compiler because hot is false and compileOnStartup is false');
		serverRoutes = new Promise((resolve, reject) => {
			fs.access(routesFileLocation, fs.constants.R_OK, (err) => {
				if (err) {
					reject("You must manually compile your application when compileOnStartup is set to false.");
				} else {
					resolve(routesFileLocation);
				}
			});
		});

	} else {
		({serverRoutes, compiler, config} = compileClient(options));
	}

	logger.notice("Starting server...");

	const serverPromises = startServer(serverRoutes, options, compiler, config);

	return {
		stop: () => Promise.all([serverPromises.stop()]),
		started: Promise.all([serverPromises.started])
			.catch(e => {
				logger.error(e);
				throw e
			})
			.then(() => logger.notice(`Ready for requests on ${bindIp}:${port}.`)),
	};
}
