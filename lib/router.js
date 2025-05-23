const http = require('node:http');
const util = require('node:util');

const debug = util.debuglog('koa-router');

const compose = require('koa-compose');
const HttpError = require('http-errors');
const { pathToRegexp } = require('path-to-regexp');

const Layer = require('./layer');

const methods = http.METHODS.map((method) => method.toLowerCase());

/**
 * @module koa-router
 */
class Router {
  constructor(opts = {}) {
    if (!(this instanceof Router)) return new Router(opts); // eslint-disable-line no-constructor-return

    this.opts = opts;
    this.methods = this.opts.methods || [
      'HEAD',
      'OPTIONS',
      'GET',
      'PUT',
      'PATCH',
      'POST',
      'DELETE'
    ];
    this.exclusive = Boolean(this.opts.exclusive);

    this.params = {};
    this.stack = [];
    this.host = this.opts.host;
    this.metadata = {}
  }

  static url(path, ...args) {
    return Layer.prototype.url.apply({ path }, args);
  }

  use(...middleware) {
    const router = this;
    let path;

    // support array of paths
    if (Array.isArray(middleware[0]) && typeof middleware[0][0] === 'string') {
      const arrPaths = middleware[0];
      for (const p of arrPaths) {
        router.use.apply(router, [p, ...middleware.slice(1)]);
      }

      return this;
    }

    const hasPath = typeof middleware[0] === 'string';
    if (hasPath) path = middleware.shift();

    for (const m of middleware) {
      if (m.router) {
        const cloneRouter = Object.assign(
          Object.create(Router.prototype),
          m.router,
          {
            stack: [...m.router.stack]
          }
        );

        for (let j = 0; j < cloneRouter.stack.length; j++) {
          const nestedLayer = cloneRouter.stack[j];
          const cloneLayer = Object.assign(
            Object.create(Layer.prototype),
            nestedLayer
          );

          if (path) cloneLayer.setPrefix(path);
          if (router.opts.prefix) cloneLayer.setPrefix(router.opts.prefix);
          router.stack.push(cloneLayer);
          cloneRouter.stack[j] = cloneLayer;
        }

        if (router.params) {
          const routerParams = Object.keys(router.params);
          for (const key of routerParams) {
            cloneRouter.param(key, router.params[key]);
          }
        }
      } else {
        const { keys } = pathToRegexp(router.opts.prefix || '', router.opts);
        const routerPrefixHasParam = Boolean(
          router.opts.prefix && keys.length > 0
        );
        router.register(path || '([^/]*)', [], m, {
          end: false,
          ignoreCaptures: !hasPath && !routerPrefixHasParam,
          pathIsRegexp: true
        });
      }
    }

    return this;
  }

  prefix(prefix) {
    prefix = prefix.replace(/\/$/, '');

    this.opts.prefix = prefix;

    for (let i = 0; i < this.stack.length; i++) {
      const route = this.stack[i];
      route.setPrefix(prefix);
    }

    return this;
  }

  middleware() {
    const router = this;
    const dispatch = (ctx, next) => {
      debug('%s %s', ctx.method, ctx.path);

      const hostMatched = router.matchHost(ctx.host);

      if (!hostMatched) {
        return next();
      }

      const path =
        router.opts.routerPath ||
        ctx.newRouterPath ||
        ctx.path ||
        ctx.routerPath;
      const matched = router.match(path, ctx.method);
      if (ctx.matched) {
        ctx.matched.push.apply(ctx.matched, matched.path);
      } else {
        ctx.matched = matched.path;
      }

      ctx.router = router;

      if (!matched.route) return next();

      const matchedLayers = matched.pathAndMethod;
      const mostSpecificLayer = matchedLayers[matchedLayers.length - 1];
      ctx._matchedRoute = mostSpecificLayer.path;
      if (mostSpecificLayer.name) {
        ctx._matchedRouteName = mostSpecificLayer.name;
      }

      const layerChain = (
        router.exclusive ? [mostSpecificLayer] : matchedLayers
      ).reduce((memo, layer) => {
        memo.push((ctx, next) => {
          ctx.captures = layer.captures(path, ctx.captures);
          ctx.request.params = layer.params(path, ctx.captures, ctx.params);
          ctx.params = ctx.request.params;
          ctx.routerPath = layer.path;
          ctx.routerName = layer.name;
          ctx._matchedRoute = layer.path;
          if (layer.name) {
            ctx._matchedRouteName = layer.name;
          }

          return next();
        });
        return [...memo, ...layer.stack];
      }, []);

      return compose(layerChain)(ctx, next);
    };

    dispatch.router = this;

    return dispatch;
  }

  routes() {
    return this.middleware();
  }

  allowedMethods(options = {}) {
    const implemented = this.methods;

    return (ctx, next) => {
      return next().then(() => {
        const allowed = {};

        if (ctx.matched && (!ctx.status || ctx.status === 404)) {
          for (let i = 0; i < ctx.matched.length; i++) {
            const route = ctx.matched[i];
            for (let j = 0; j < route.methods.length; j++) {
              const method = route.methods[j];
              allowed[method] = method;
            }
          }

          const allowedArr = Object.keys(allowed);
          if (!implemented.includes(ctx.method)) {
            if (options.throw) {
              const notImplementedThrowable =
                typeof options.notImplemented === 'function'
                  ? options.notImplemented() // set whatever the user returns from their function
                  : new HttpError.NotImplemented();

              throw notImplementedThrowable;
            } else {
              ctx.status = 501;
              ctx.set('Allow', allowedArr.join(', '));
            }
          } else if (allowedArr.length > 0) {
            if (ctx.method === 'OPTIONS') {
              ctx.status = 200;
              ctx.body = '';
              ctx.set('Allow', allowedArr.join(', '));
            } else if (!allowed[ctx.method]) {
              if (options.throw) {
                const notAllowedThrowable =
                  typeof options.methodNotAllowed === 'function'
                    ? options.methodNotAllowed() // set whatever the user returns from their function
                    : new HttpError.MethodNotAllowed();

                throw notAllowedThrowable;
              } else {
                ctx.status = 405;
                ctx.set('Allow', allowedArr.join(', '));
              }
            }
          }
        }
      });
    };
  }

  all(name, path, middleware) {
    if (typeof path === 'string' || path instanceof RegExp) {
      middleware = Array.prototype.slice.call(arguments, 2);
    } else {
      middleware = Array.prototype.slice.call(arguments, 1);
      path = name;
      name = null;
    }

    if (
      typeof path !== 'string' &&
      !(path instanceof RegExp) &&
      (!Array.isArray(path) || path.length === 0)
    )
      throw new Error('You have to provide a path when adding an all handler');

    const opts = {
      name,
      pathIsRegexp: path instanceof RegExp
    };

    this.register(path, methods, middleware, { ...this.opts, ...opts });

    return this;
  }

  redirect(source, destination, code) {
    // lookup source route by name
    if (typeof source === 'symbol' || source[0] !== '/') {
      source = this.url(source);
      if (source instanceof Error) throw source;
    }

    // lookup destination route by name
    if (
      typeof destination === 'symbol' ||
      (destination[0] !== '/' && !destination.includes('://'))
    ) {
      destination = this.url(destination);
      if (destination instanceof Error) throw destination;
    }

    return this.all(source, (ctx) => {
      ctx.redirect(destination);
      ctx.status = code || 301;
    });
  }

  register(path, methods, middleware, newOpts = {}) {
    const router = this;
    const { stack } = this;
    const opts = { ...this.opts, ...newOpts };
    if (Array.isArray(path)) {
      for (const curPath of path) {
        router.register.call(router, curPath, methods, middleware, opts);
      }

      return this;
    }

    // create route
    const route = new Layer(path, methods, middleware, {
      end: opts.end === false ? opts.end : true,
      name: opts.name,
      sensitive: opts.sensitive || false,
      strict: opts.strict || false,
      prefix: opts.prefix || '',
      ignoreCaptures: opts.ignoreCaptures,
      pathIsRegexp: opts.pathIsRegexp
    },this.metadata);

    if (this.opts.prefix) {
      route.setPrefix(this.opts.prefix);
    }

    for (let i = 0; i < Object.keys(this.params).length; i++) {
      const param = Object.keys(this.params)[i];
      route.param(param, this.params[param]);
    }

    stack.push(route);

    debug('defined route %s %s', route.methods, route.path);

    return route;
  }

  route(name) {
    const routes = this.stack;

    for (let len = routes.length, i = 0; i < len; i++) {
      if (routes[i].name && routes[i].name === name) return routes[i];
    }

    return false;
  }

  url(name, ...args) {
    const route = this.route(name);
    if (route) return route.url.apply(route, args);

    return new Error(`No route found for name: ${String(name)}`);
  }

  match(path, method) {
    const layers = this.stack;
    let layer;
    const matched = {
      path: [],
      pathAndMethod: [],
      route: false
    };

    for (let len = layers.length, i = 0; i < len; i++) {
      layer = layers[i];

      debug('test %s %s', layer.path, layer.regexp);

      // eslint-disable-next-line unicorn/prefer-regexp-test
      if (layer.match(path)) {
        matched.path.push(layer);

        if (layer.methods.length === 0 || layer.methods.includes(method)) {
          matched.pathAndMethod.push(layer);
          if (layer.methods.length > 0) matched.route = true;
        }
      }
    }

    return matched;
  }

  matchHost(input) {
    const { host } = this;

    if (!host) {
      return true;
    }

    if (!input) {
      return false;
    }

    if (typeof host === 'string') {
      return input === host;
    }

    if (typeof host === 'object' && host instanceof RegExp) {
      return host.test(input);
    }
  }

  param(param, middleware) {
    this.params[param] = middleware;
    for (let i = 0; i < this.stack.length; i++) {
      const route = this.stack[i];
      route.param(param, middleware);
    }

    return this;
  }

  meta(data) {
    this.metadata = data
    return this
  }
}

for (const method of methods) {
  Router.prototype[method] = function (name, path, middleware) {
    if (typeof path === 'string' || path instanceof RegExp) {
      middleware = Array.prototype.slice.call(arguments, 2);
    } else {
      middleware = Array.prototype.slice.call(arguments, 1);
      path = name;
      name = null;
    }

    if (
      typeof path !== 'string' &&
      !(path instanceof RegExp) &&
      (!Array.isArray(path) || path.length === 0)
    )
      throw new Error(
        `You have to provide a path when adding a ${method} handler`
      );

    const opts = {
      name,
      pathIsRegexp: path instanceof RegExp
    };

    this.register(path, [method], middleware, { ...this.opts, ...opts });
    return this;
  };
}

Router.prototype.del = Router.prototype['delete'];

module.exports = Router;
