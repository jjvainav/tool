import { NextFunction, Request, RequestHandler, Response } from "express";
import createError from "http-errors";
import { AuthenticationVerifyResult, IAuthenticationHandler, IAuthenticationObserver, IChallengeParameters } from "./authentication";

declare module "@shrub/express/dist/request-context" {
    interface IRequestContext {
        readonly identity?: IIdentity;
    }
}

export interface IChallengeOptions {
    /** A set of parameters that get passed to an authentication handler when challenging authorization. */
    readonly parameters?: IChallengeParameters;
    /** An optional scheme to challenge. */
    readonly scheme?: string;
}

export interface ILoginOptions {
    readonly scheme?: string;
    readonly user: any;
    readonly auth: any;
}

/** Manages authenticated users for a request. */
export interface IIdentity {
    /** The authentication scheme responsible for authenticating the user. */
    readonly scheme?: string;
    /** The authorization info for the current user. */
    readonly auth?: any;
    /** The user information for an authenticated user. */
    readonly user?: any;
    /** True if the current request has an authenticated user. */
    readonly isAuthenticated: boolean;

    /** Challenges an authentication scheme. */
    challenge(options?: IChallengeOptions): void;
    /** Denies access for the current user. */
    deny(): void;    
    /** Invoke to create a new user session for an authenticated user. */
    login(user: any, auth: any): void;
    /** Invoke to log out the currently authenticated user and destroy the user session. */
    logout(): void;
}

/** Defines options for the identity middleware. */
export interface IIdentityOptions {
    /** A list of authentication handlers responsible for authenticating a request. */
    readonly authenticationHandlers: IAuthenticationHandler[];
    /** An optional list of authentication observers. */
    readonly authenticationObservers?: IAuthenticationObserver[];
    /** An optional default authentication scheme; if none is provided the first handler will be the default. */
    readonly defaultScheme?: string;
}

/** Middleware that handles authenticating requests and setting a user's identity. */
export function identity(options: IIdentityOptions): RequestHandler {
    return (req, res, next) => {
        const identity = {
            get isAuthenticated(): boolean { 
                return (<any>this).user !== undefined; 
            },
            challenge: function(challengeOptions?: IChallengeOptions) {
                let scheme = challengeOptions && challengeOptions.scheme
                    ? challengeOptions.scheme
                    : options.defaultScheme;

                if (scheme) {
                    const handler = getHandler(options.authenticationHandlers, scheme);
                    if (!handler) {
                        throw new Error(`Invalid scheme (${scheme}), no authentication handler found.`);
                    }

                    challenge(handler, challengeOptions && challengeOptions.parameters, undefined, req, res, next);
                }
                else if (options.authenticationHandlers.length === 1) {
                    challenge(options.authenticationHandlers[0], challengeOptions && challengeOptions.parameters, undefined, req, res, next);
                }
                else {
                    throw new Error("Multiple authentication handlers registered and no default scheme defined.");
                }
            },
            deny: function() {
                const handler = getHandler(options.authenticationHandlers, (<any>this).scheme);
                if (handler) {
                    deny(handler, req, res, next);
                }
                else {
                    next(createError(403));
                }
            },
            login: function(user: any, auth: any) {
                // note: When a user is logged in do not set the user/auth, the authentication handlers
                // are responsible for processing requests and setting the user/auth properties. In general,
                // the user/auth properties will be available upon the next request.
                on(options.authenticationHandlers, o => o.onLogin, fn => fn(req, user, auth));
                on(options.authenticationObservers, o => o.onLogin, fn => fn(req, user, auth));
            },
            logout: function() {
                if (this.isAuthenticated) {
                    on(options.authenticationHandlers, o => o.onLogout, fn => fn(req, (<any>this).user, (<any>this).auth));
                    on(options.authenticationObservers, o => o.onLogout, fn => fn(req, (<any>this).user, (<any>this).auth));

                    delete (<any>this).scheme;
                    delete (<any>this).user;
                    delete (<any>this).auth;
                }
            }
        };

        let isDone = false;
        // invoked after processing authentication handlers
        const done = (err?: Error) => {
            isDone = true;
            // do not set the identity object after authentication
            (<any>req.context).identity = identity;
            next(err);
        };

        if (options.authenticationHandlers.length) {
            // index for the current authentication handler
            let index = 0;
            const result: AuthenticationVerifyResult = {
                success: (user, auth) => {
                    if (isDone) { throw new Error("Authentication processing is already done."); }
                    if (!user) { throw new Error("user required"); }
                    if (!auth) { throw new Error("auth required"); }

                    (<any>identity).scheme = options.authenticationHandlers[index].scheme;
                    (<any>identity).user = user;
                    (<any>identity).auth = auth;

                    done();
                },
                fail: message => {
                    if (isDone) { throw new Error("Authentication processing is already done."); }
                    // TODO: raise an event with the message so it can be logged? tie into the trace support?
                    challenge(options.authenticationHandlers[index], undefined, message, req, res, done);
                },
                error: err => {
                    if (isDone) { throw new Error("Authentication processing is already done."); }
                    done(err);
                },
                skip: () => {
                    if (isDone) { throw new Error("Authentication processing is already done."); }

                    index++;
                    if (options.authenticationHandlers.length === index) {
                        return done();
                    }

                    options.authenticationHandlers[index].authenticate(req, result);
                }
            };

            // this will initiate the first authentication handler; each handler is expected
            // to invoke one of the result functions and if the handler wants to ignore or pass
            // the request to the next handler it should invoke 'skip'
            options.authenticationHandlers[index].authenticate(req, result);
        }
        else {
            done();
        }
    };
}

function on<TFunction extends Function>(
    observers: IAuthenticationObserver[] | undefined, 
    getCallback: (observer: IAuthenticationObserver) => TFunction | undefined,
    invoke: (fn: TFunction) => void): void {
    if (observers) {
        observers.forEach(observer => {
            const fn = getCallback(observer);
            if (fn) {
                invoke(fn);
            }
        });
    }
}

function challenge(handler: IAuthenticationHandler, parameters: IChallengeParameters | undefined, message: string | undefined, req: Request, res: Response, next: NextFunction): void {
    // note: need to be careful to ONLY invoke next with an error since this function is exposed to handlers down the chain
    if (handler.challenge) {
        handler.challenge!(req, {
            redirect: url => res.redirect(url),
            send: err => next(err),
            error: err => next(err)
        }, 
        parameters,
        message);
    }
    else {
        next(createError(401));
    }
}

function deny(handler: IAuthenticationHandler, req: Request, res: Response, next: NextFunction): void {
    // note: need to be careful to ONLY invoke next with an error since this function is exposed to handlers down the chain
    if (handler.deny) {
        handler.deny!(req, {
            redirect: url => res.redirect(url),
            send: err => next(err),
            error: err => next(err)
        });
    }
    else {
        next(createError(403));
    }
}

function getHandler(handlers: IAuthenticationHandler[], scheme: string): IAuthenticationHandler | undefined {
    for (const handler of handlers) {
        if (handler.scheme === scheme) {
            return handler;
        }
    }

    return undefined;
}