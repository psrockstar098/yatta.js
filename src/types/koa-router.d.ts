// Minimal type declarations for @koa/router (no @types package with real definitions)
declare module "@koa/router" {
  import type { Middleware } from "koa";
  export default class Router {
    constructor(opts?: unknown);
    get(path: string, ...middleware: Middleware[]): this;
    post(path: string, ...middleware: Middleware[]): this;
    put(path: string, ...middleware: Middleware[]): this;
    delete(path: string, ...middleware: Middleware[]): this;
    patch(path: string, ...middleware: Middleware[]): this;
    head(path: string, ...middleware: Middleware[]): this;
    options(path: string, ...middleware: Middleware[]): this;
    all(path: string, ...middleware: Middleware[]): this;
    routes(): Middleware;
    allowedMethods(): Middleware;
  }
}
