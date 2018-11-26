/* @flow */
/* eslint max-lines: 0 */

import { send, bridge, serializeMessage, ProxyWindow } from 'post-robot/src';
import { isSameDomain, isTop, isSameTopWindow, matchDomain,
    getDistanceFromTop, onCloseWindow, getDomain, type CrossDomainWindowType } from 'cross-domain-utils/src';
import { ZalgoPromise } from 'zalgo-promise/src';
import { addEventListener, uniqueID, elementReady, writeElementToWindow,
    noop, showAndAnimate, animateAndHide, showElement, hideElement,
    addClass, extend, extendUrl,
    setOverflow, elementStoppedMoving, getElement, memoized, appendChild,
    once, stringify, stringifyError, eventEmitter, type EventEmitterType } from 'belter/src';
import { node, dom, ElementNode } from 'jsx-pragmatic/src';

import { buildChildWindowName } from '../window';
import { POST_MESSAGE, CONTEXT_TYPES, CLASS_NAMES, ANIMATION_NAMES,
    CLOSE_REASONS, DELEGATE, INITIAL_PROPS, WINDOW_REFERENCES, EVENTS, DEFAULT_DIMENSIONS } from '../../constants';
import type { Component } from '../component';
import { global, cleanup, type CleanupType } from '../../lib';
import type { PropsType, BuiltInPropsType } from '../component/props';
import type { ChildExportsType } from '../child';
import type { CancelableType, DimensionsType, ElementRefType } from '../../types';

import { RENDER_DRIVERS, type ContextDriverType } from './drivers';
import { propsToQuery, normalizeProps } from './props';

global.props = global.props || {};
global.windows = global.windows || {};

export type RenderOptionsType<P> = {
    id : string,
    props : PropsType & P,
    tag : string,
    context : string,
    outlet : HTMLElement,
    CLASS : typeof CLASS_NAMES,
    ANIMATION : typeof ANIMATION_NAMES,
    CONTEXT : typeof CONTEXT_TYPES,
    EVENT : typeof EVENTS,
    actions : {
        close : (?string) => ZalgoPromise<void>,
        focus : () => ZalgoPromise<void>
    },
    on : (string, () => void) => CancelableType,
    jsxDom : typeof node,
    document : Document,
    container? : HTMLElement,
    dimensions : DimensionsType,
    doc? : Document
};

export type ParentExportsType<P> = {
    init : (ChildExportsType<P>) => ZalgoPromise<void>,
    close : (string) => ZalgoPromise<void>,
    checkClose : () => ZalgoPromise<void>,
    resize : (?number, ?number) => ZalgoPromise<void>,
    trigger : (string) => ZalgoPromise<void>,
    hide : () => ZalgoPromise<void>,
    show : () => ZalgoPromise<void>,
    error : (mixed) => ZalgoPromise<void>
};

/*  Parent Component
    ----------------

    This manages the state of the component on the parent window side - i.e. the window the component is being rendered into.

    It handles opening the necessary windows/iframes, launching the component's url, and listening for messages back from the component.
*/

export class ParentComponent<P> {

    component : Component<P>
    context : string
    driver : ContextDriverType
    props : BuiltInPropsType & P
    onInit : ZalgoPromise<ParentComponent<P>>
    errored : boolean
    event : EventEmitterType
    clean : CleanupType

    container : HTMLElement
    element : HTMLElement
    iframe : HTMLIFrameElement
    prerenderIframe : HTMLIFrameElement

    childExports : ?ChildExportsType<P>
    timeout : ?TimeoutID // eslint-disable-line no-undef

    constructor(component : Component<P>, context : string, { props } : { props : (PropsType & P) }) {
        ZalgoPromise.try(() => {
            this.onInit = new ZalgoPromise();
            this.clean = cleanup(this);
            this.event = eventEmitter();

            this.component = component;
            this.context = context;
            this.driver = RENDER_DRIVERS[this.context];
    
            this.setProps(props);
            this.registerActiveComponent();
            this.watchForUnload();
    
            return this.onInit;

        }).catch(err => {
            return this.error(err, props);
        });
    }

    render(element : ElementRefType, target? : CrossDomainWindowType = window) : ZalgoPromise<ParentComponent<P>> {
        return this.tryInit(() => {

            this.component.log(`render_${ this.context }`, { context: this.context, element });

            let tasks = {};
            
            tasks.onRender = this.props.onRender();

            tasks.getDomain = this.getDomain();

            tasks.elementReady = ZalgoPromise.try(() => {
                if (element) {
                    return this.elementReady(element);
                }
            });

            let focus = () => {
                return tasks.awaitWindow.then(win => {
                    return win.focus();
                });
            };

            tasks.openContainer = tasks.elementReady.then(() => {
                return this.openContainer(element, { focus });
            });

            tasks.open = this.driver.renderedIntoContainer
                ? tasks.openContainer.then(() => this.open())
                : this.open();

            tasks.awaitWindow = tasks.open.then(proxyWin => {
                return proxyWin.awaitWindow();
            });

            tasks.showContainer = tasks.openContainer.then(() => {
                return this.showContainer();
            });

            tasks.setWindowName = ZalgoPromise.all([ tasks.open, tasks.getDomain ]).then(([ proxyWin, domain ]) => {
                return this.setWindowName(proxyWin, this.buildChildWindowName({ proxyWin, domain, target }));
            });

            tasks.watchForClose = ZalgoPromise.all([ tasks.awaitWindow, tasks.setWindowName ]).then(([ win ]) => {
                return this.watchForClose(win);
            });

            tasks.prerender = ZalgoPromise.all([ tasks.open, tasks.openContainer ]).then(([ proxyWin ]) => {
                return this.prerender(proxyWin);
            });

            tasks.showComponent = tasks.prerender.then(() => {
                return this.showComponent();
            });

            tasks.openBridge = ZalgoPromise.all([ tasks.awaitWindow, tasks.getDomain, tasks.setWindowName ]).then(([ win, domain ]) => {
                return this.openBridge(win, domain);
            });

            tasks.buildUrl = this.buildUrl();

            tasks.loadUrl = ZalgoPromise.all([
                tasks.open,
                tasks.buildUrl,
                tasks.setWindowName
            ]).then(([ proxyWin, url ]) => {
                return this.loadUrl(proxyWin, url);
            });

            tasks.switchPrerender = ZalgoPromise.all([ tasks.prerender, this.onInit ]).then(() => {
                return this.switchPrerender();
            });

            tasks.runTimeout = tasks.loadUrl.then(() => {
                return this.runTimeout();
            });

            return ZalgoPromise.hash(tasks);

        }).then(() => {
            return this.props.onEnter();
        }).then(() => {
            return this;
        });
    }

    renderTo(target : CrossDomainWindowType, element : ?string) : ZalgoPromise<ParentComponent<P>> {
        return this.tryInit(() => {
            if (target === window) {
                return this.render(element);
            }

            if (element && typeof element !== 'string') {
                throw new Error(`Element passed to renderTo must be a string selector, got ${ typeof element } ${ element }`);
            }

            this.checkAllowRemoteRender(target);

            this.component.log(`render_${ this.context }_to_win`, { element: stringify(element), context: this.context });

            this.delegate(target);
            return this.render(element, target);
        });
    }

    on(eventName : string, handler : () => void) : CancelableType {
        return this.event.on(eventName, handler);
    }

    @memoized
    getOutlet() : HTMLElement {
        let outlet = document.createElement('div');
        addClass(outlet, CLASS_NAMES.OUTLET);
        return outlet;
    }

    checkAllowRemoteRender(target : CrossDomainWindowType) {

        if (!target) {
            throw this.component.createError(`Must pass window to renderTo`);
        }

        if (!isSameTopWindow(window, target)) {
            throw new Error(`Can only renderTo an adjacent frame`);
        }

        if (isSameDomain(target)) {
            return;
        }

        let origin = getDomain();
        let domain = this.component.getDomain(null, this.props.env);

        if (!domain) {
            throw new Error(`Could not determine domain to allow remote render`);
        }

        if (matchDomain(domain, origin)) {
            return;
        }

        throw new Error(`Can not render remotely to ${ domain.toString() } - can only render to ${ origin }`);
    }

    registerActiveComponent() {
        ParentComponent.activeComponents.push(this);

        this.clean.register(() => {
            ParentComponent.activeComponents.splice(ParentComponent.activeComponents.indexOf(this), 1);
        });
    }


    getComponentParentRef(renderToWindow : CrossDomainWindowType = window) : { ref : string, uid? : string, distance? : number } {

        if (this.context === CONTEXT_TYPES.POPUP) {
            return { ref: WINDOW_REFERENCES.OPENER };
        }

        if (renderToWindow === window) {

            if (isTop(window)) {
                return { ref: WINDOW_REFERENCES.TOP };
            }

            return { ref: WINDOW_REFERENCES.PARENT, distance: getDistanceFromTop(window) };
        }

        let uid = uniqueID();
        global.windows[uid] = window;

        this.clean.register(() => {
            delete global.windows[uid];
        });

        return { ref: WINDOW_REFERENCES.GLOBAL, uid };
    }

    buildChildWindowName({ proxyWin, domain, target = window } : { proxyWin : ProxyWindow, domain : string, target : CrossDomainWindowType } = {}) : string {

        let uid    = uniqueID();
        let tag    = this.component.tag;
        let sProps = serializeMessage(proxyWin, domain, this.getPropsForChild());

        let componentParent = this.getComponentParentRef(target);

        let props = isSameDomain(target)
            ? { type: INITIAL_PROPS.RAW, value: sProps }
            : { type: INITIAL_PROPS.UID, uid };

        if (props.type === INITIAL_PROPS.UID) {
            global.props[uid] = sProps;

            this.clean.register(() => {
                delete global.props[uid];
            });
        }
        
        let exports = serializeMessage(proxyWin, domain, this.buildParentExports(proxyWin));
        let id = uniqueID();
        let thisdomain = getDomain(window);
        let context = this.context;

        return buildChildWindowName(this.component.name, { id, context, domain: thisdomain, uid, tag, componentParent, props, exports });
    }

    setProps(props : (PropsType & P), isUpdate : boolean = false) {

        if (this.component.validate) {
            this.component.validate(this.component, props);
        }

        // $FlowFixMe
        this.props = this.props || {};

        extend(this.props, normalizeProps(this.component, this, props, isUpdate));
    }

    @memoized
    buildUrl() : ZalgoPromise<string> {
        return propsToQuery({ ...this.component.props, ...this.component.builtinProps }, this.props)
            .then(query => {
                let url = this.component.getUrl(this.props.env, this.props);
                return extendUrl(url, { query: { ...query } });
            });
    }


    getDomain() : ZalgoPromise<string> {
        return ZalgoPromise.try(() => {

            let domain = this.component.getDomain(null, this.props.env);

            if (domain) {
                return domain;
            }

            if (this.component.buildUrl) {
                return ZalgoPromise.try(() => this.component.buildUrl(this.props)).then(builtUrl => {
                    return this.component.getDomain(builtUrl, this.props.env);
                });
            }

        }).then(domain => {

            if (!domain) {
                throw new Error(`Could not determine domain`);
            }

            return domain;
        });
    }

    getPropsForChild() : (BuiltInPropsType & P) {

        let result = {};

        for (let key of Object.keys(this.props)) {
            let prop = this.component.getProp(key);

            if (!prop || prop.sendToChild !== false) {
                // $FlowFixMe
                result[key] = this.props[key];
            }
        }

        // $FlowFixMe
        return result;
    }

    updateProps(props : (PropsType & P)) : ZalgoPromise<void> {
        this.setProps(props, true);

        return this.onInit.then(() => {
            if (this.childExports) {
                return this.childExports.updateProps(this.getPropsForChild());
            } else {
                throw new Error(`Child exports were not available`);
            }
        });
    }


    openBridge(win : CrossDomainWindowType, domain : string) : ZalgoPromise<?CrossDomainWindowType> {
        return ZalgoPromise.try(() => {
            if (!bridge || !bridge.needsBridge({ win, domain }) || bridge.hasBridge(domain, domain)) {
                return;
            }

            let bridgeUrl = this.component.getBridgeUrl(this.props.env);
            let bridgeDomain = this.component.getBridgeDomain(this.props.env);

            if (!bridgeUrl || !bridgeDomain) {
                throw new Error(`Bridge url and domain needed to render ${ this.context }`);
            }

            bridge.linkUrl(win, domain);
            return bridge.openBridge(bridgeUrl, bridgeDomain);
        });
    }
    
    open() : ZalgoPromise<ProxyWindow> {
        return ZalgoPromise.try(() => {
            this.component.log(`open_${ this.context }`);
            return this.driver.open.call(this);
        });
    }

    setWindowName(proxyWin : ProxyWindow, name : string) : ZalgoPromise<ProxyWindow> {
        return proxyWin.setName(name);
    }

    switchPrerender() : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            if (this.component.prerenderTemplate && this.driver.switchPrerender) {
                return this.driver.switchPrerender.call(this);
            }
        });
    }

    elementReady(element : ElementRefType) : ZalgoPromise<void> {
        return elementReady(element).then(noop);
    }


    delegate(target : CrossDomainWindowType) {
        this.component.log(`delegate_${ this.context }`);

        let props = {
            uid:        this.props.uid,
            dimensions: this.props.dimensions,
            onClose:    this.props.onClose,
            onDisplay:  this.props.onDisplay
        };

        for (let propName of this.component.getPropNames()) {
            let prop = this.component.getProp(propName);

            if (prop.allowDelegate) {
                props[propName] = this.props[propName];
            }
        }

        let delegate = send(target, `${ POST_MESSAGE.DELEGATE }_${ this.component.name }`, {

            context: this.context,
            env:     this.props.env,

            options: {
                context: this.context,
                props,

                overrides: {
                    userClose:            () => this.userClose(),
                    getDomain:            () => this.getDomain(),

                    error: (err) => this.error(err),
                    on:    (eventName, handler) => this.on(eventName, handler)
                }
            }

        }).then(({ data }) => {
            this.clean.register(data.destroy);
            return data;

        }).catch(err => {
            throw new Error(`Unable to delegate rendering. Possibly the component is not loaded in the target window.\n\n${ stringifyError(err) }`);
        });

        let overrides = this.driver.delegateOverrides;
        for (let key of Object.keys(overrides)) {
            let val = overrides[key];

            if (val === DELEGATE.CALL_DELEGATE) {
                // $FlowFixMe
                this[key] = function overridenFunction() : ZalgoPromise<mixed> {
                    return delegate.then(data => {
                        return data.overrides[key].apply(this, arguments);
                    });
                };
            }
        }
    }

    watchForClose(win : CrossDomainWindowType) {
        let closeWindowListener = onCloseWindow(win, () => {
            this.component.log(`detect_close_child`);

            return ZalgoPromise.try(() => {
                return this.props.onClose(CLOSE_REASONS.CLOSE_DETECTED);
            }).finally(() => {
                return this.destroy();
            });
        }, 3000);

        this.clean.register('destroyCloseWindowListener', closeWindowListener.cancel);
    }

    watchForUnload() {

        // Our child has no way of knowing if we navigated off the page. So we have to listen for unload
        // and close the child manually if that happens.

        let onunload = once(() => {
            this.component.log(`navigate_away`);
            this.destroyComponent();
        });

        let unloadWindowListener = addEventListener(window, 'unload', onunload);

        this.clean.register('destroyUnloadWindowListener', unloadWindowListener.cancel);
    }

    loadUrl(proxyWin : ProxyWindow, url : string) : ZalgoPromise<ProxyWindow> {
        this.component.log(`load_url`);
        return proxyWin.setLocation(url);
    }

    runTimeout() {
        let timeout = this.props.timeout;

        if (timeout) {
            let id = this.timeout = setTimeout(() => {
                this.component.log(`timed_out`, { timeout: timeout.toString() });
                this.error(this.component.createError(`Loading component timed out after ${ timeout } milliseconds`));
            }, timeout);

            this.clean.register(() => {
                clearTimeout(id);
                delete this.timeout;
            });
        }
    }

    initChild(childExports : ChildExportsType<P>) : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            this.childExports = childExports;
            this.onInit.resolve(this);
    
            if (this.timeout) {
                clearTimeout(this.timeout);
            }
        });
    }

    buildParentExports(win : ProxyWindow) : ParentExportsType<P> {
        return {
            init:       (childExports) => this.initChild(childExports),
            close:      (reason) => this.close(reason),
            checkClose: () => this.checkClose(win),
            resize:     (width, height) => this.resize(width, height),
            trigger:    (name) => ZalgoPromise.try(() => this.event.trigger(name)),
            hide:       () => ZalgoPromise.try(() => this.hide()),
            show:       () => ZalgoPromise.try(() => this.show()),
            error:      (err) => this.error(err)
        };
    }

    /*  Resize
        ------

        Resize the child component window
    */

    resize(width : ?(number | string), height : ?(number | string), { waitForTransition = true } : { waitForTransition : boolean } = {}) : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            this.component.log(`resize`, { height: stringify(height), width: stringify(width) });
            this.driver.resize.call(this, width, height);

            if (!waitForTransition) {
                return;
            }

            if (this.element) {

                let overflow;

                if (this.element) {
                    overflow = setOverflow(this.element, 'hidden');
                }

                return elementStoppedMoving(this.element).then(() => {

                    if (overflow) {
                        overflow.reset();
                    }
                });
            }
        });
    }


    /*  Hide
        ----

        Hide the component and any parent template
    */

    hide() : void {

        if (this.container) {
            hideElement(this.container);
        }

        return this.driver.hide.call(this);
    }

    show() : void {

        if (this.container) {
            showElement(this.container);
        }

        return this.driver.show.call(this);
    }


    checkClose(win : ProxyWindow) : ZalgoPromise<void> {
        return win.isClosed().then(closed => {
            if (closed) {
                return this.userClose();
            }

            return ZalgoPromise.delay(200)
                .then(() => win.isClosed())
                .then(secondClosed => {
                    if (secondClosed) {
                        return this.userClose();
                    }
                });
        });
    }


    userClose() : ZalgoPromise<void> {
        return this.close(CLOSE_REASONS.USER_CLOSED);
    }


    /*  Close
        -----

        Close the child component
    */

    @memoized
    close(reason? : string = CLOSE_REASONS.PARENT_CALL) : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {

            this.component.log(`close`, { reason });

            this.event.triggerOnce(EVENTS.CLOSE);
            return this.props.onClose(reason);

        }).then(() => {

            return ZalgoPromise.all([
                this.closeComponent(),
                this.closeContainer()
            ]);

        }).then(() => {

            return this.destroy();
        });
    }


    @memoized
    closeContainer(reason : string = CLOSE_REASONS.PARENT_CALL) : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {

            this.event.triggerOnce(EVENTS.CLOSE);
            return this.props.onClose(reason);

        }).then(() => {

            return ZalgoPromise.all([
                this.closeComponent(reason),
                this.hideContainer()
            ]);

        }).then(() => {

            return this.destroyContainer();
        });
    }


    @memoized
    destroyContainer() : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            this.clean.run('destroyContainerEvents');
            this.clean.run('destroyContainerTemplate');
        });
    }


    @memoized
    closeComponent(reason : string = CLOSE_REASONS.PARENT_CALL) : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            return this.cancelContainerEvents();

        }).then(() => {
            this.event.triggerOnce(EVENTS.CLOSE);
            return this.props.onClose(reason);

        }).then(() => {
            return this.hideComponent();

        }).then(() => {
            return this.destroyComponent();

        }).then(() => {
            // IE in metro mode -- child window needs to close itself, or close will hang
            if (this.childExports && this.context === CONTEXT_TYPES.POPUP) {
                this.childExports.close().catch(noop);
            }
        });
    }

    destroyComponent() {
        this.clean.run('destroyUnloadWindowListener');
        this.clean.run('destroyCloseWindowListener');
        this.clean.run('destroyContainerEvents');
        this.clean.run('destroyWindow');
    }

    @memoized
    showContainer() : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            if (this.props.onDisplay) {
                return this.props.onDisplay();
            }
        }).then(() => {
            if (this.container) {
                return showAndAnimate(this.container, ANIMATION_NAMES.SHOW_CONTAINER, this.clean.register);
            }
        });
    }

    @memoized
    showComponent() : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            if (this.props.onDisplay) {
                return this.props.onDisplay();
            }
        }).then(() => {
            if (this.element) {
                return showAndAnimate(this.element, ANIMATION_NAMES.SHOW_COMPONENT, this.clean.register);
            }
        });
    }

    @memoized
    hideContainer() : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            if (this.container) {
                return animateAndHide(this.container, ANIMATION_NAMES.HIDE_CONTAINER, this.clean.register);
            }
        });
    }

    @memoized
    hideComponent() : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            if (this.element) {
                return animateAndHide(this.element, ANIMATION_NAMES.HIDE_COMPONENT, this.clean.register);
            }
        });
    }


    /*  Create Component Template
        -------------------------

        Creates an initial template and stylesheet which are loaded into the child window, to be displayed before the url is loaded
    */

    prerender(proxyWin : ProxyWindow) : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            if (!this.component.prerenderTemplate) {
                return;
            }

            return ZalgoPromise.try(() => {
                return proxyWin.awaitWindow();

            }).then(win => {
                return this.driver.openPrerender.call(this, win);
                
            }).then(prerenderWindow => {
                if (!prerenderWindow) {
                    return;
                }
        
                let doc = prerenderWindow.document;
                let el = this.renderTemplate(this.component.prerenderTemplate, { document: doc });
    
                if (el instanceof ElementNode) {
                    el = el.render(dom({ doc }));
                }
    
                try {
                    writeElementToWindow(prerenderWindow, el);
                } catch (err) {
                    // pass
                }
            });
        });
    }

    renderTemplate<T : HTMLElement | ElementNode>(renderer : (RenderOptionsType<P>) => T, { focus, container, document } : { focus? : () => ZalgoPromise<void>, container? : HTMLElement, document? : Document }) : T {
        let {
            width  = `${ DEFAULT_DIMENSIONS.WIDTH }px`,
            height = `${ DEFAULT_DIMENSIONS.HEIGHT }px`
        } = (this.component.dimensions || {});

        focus = focus || (() => ZalgoPromise.resolve());

        // $FlowFixMe
        return renderer.call(this, {
            id:        `${ CLASS_NAMES.ZOID }-${ this.component.tag }-${ this.props.uid }`,
            props:     renderer.__xdomain__ ? null : this.props,
            tag:       this.component.tag,
            context:   this.context,
            outlet:    this.getOutlet(),
            CLASS:     CLASS_NAMES,
            ANIMATION: ANIMATION_NAMES,
            CONTEXT:   CONTEXT_TYPES,
            EVENT:     EVENTS,
            actions:   {
                focus,
                close: () => this.userClose()
            },
            on:         (eventName, handler) => this.on(eventName, handler),
            jsxDom:     node,
            document,
            dimensions: { width, height },
            container
        });
    }

    openContainer(element : ?HTMLElement, { focus } : { focus? : () => ZalgoPromise<void> }) : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            let el;

            if (element) {
                el = getElement(element);
            } else {
                el = document.body;
            }

            if (!el) {
                throw new Error(`Could not find element to open container into`);
            }

            if (!this.component.containerTemplate) {
                if (this.driver.renderedIntoContainer) {
                    throw new Error(`containerTemplate needed to render ${ this.context }`);
                }

                return;
            }

            let container = this.renderTemplate(this.component.containerTemplate, { container: el, focus });

            if (container instanceof ElementNode) {
                container = container.render(dom({ doc: document }));
            }

            this.container = container;
            hideElement(this.container);
            appendChild(el, this.container);

            if (this.driver.renderedIntoContainer) {
                this.element = this.getOutlet();
                hideElement(this.element);

                if (!this.element) {
                    throw new Error('Could not find element to render component into');
                }

                hideElement(this.element);
            }

            this.clean.register('destroyContainerTemplate', () => {

                if (this.container && this.container.parentNode) {
                    this.container.parentNode.removeChild(this.container);
                }

                delete this.container;
            });
        });
    }

    cancelContainerEvents() {
        this.clean.run('destroyContainerEvents');
    }

    destroy() : ZalgoPromise<void> {
        return ZalgoPromise.try(() => {
            if (this.clean.hasTasks()) {
                this.component.log(`destroy`);
                return this.clean.all();
            }
        });
    }


    tryInit(method : () => mixed) : ZalgoPromise<ParentComponent<P>> {
        return ZalgoPromise.try(method).catch(err => {
            this.onInit.reject(err);
        }).then(() => {
            return this.onInit;
        });
    }

    // $FlowFixMe
    error(err : mixed, props : PropsType & P = this.props) : ZalgoPromise<void> {
        if (this.errored) {
            return;
        }

        this.errored = true;

        // eslint-disable-next-line promise/no-promise-in-callback
        return ZalgoPromise.try(() => {
            this.onInit = this.onInit || new ZalgoPromise();
            this.onInit.reject(err);

            return this.destroy();

        }).then(() => {
            if (props.onError) {
                return props.onError(err);
            }

        }).catch(errErr => { // eslint-disable-line unicorn/catch-error-name
            throw new Error(`An error was encountered while handling error:\n\n ${ stringifyError(err) }\n\n${ stringifyError(errErr) }`);

        }).then(() => {
            if (!props.onError) {
                throw err;
            }
        });
    }

    static activeComponents : Array<ParentComponent<*>> = []

    static destroyAll() : ZalgoPromise<void> {
        let results = [];

        while (ParentComponent.activeComponents.length) {
            results.push(ParentComponent.activeComponents[0].destroy());
        }

        return ZalgoPromise.all(results).then(noop);
    }
}
