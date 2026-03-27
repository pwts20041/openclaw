"use strict";

let stub;
const stubZodMeta = new Proxy(
  {
    parent: undefined,
    def: Object.create(null),
    bag: Object.create(null),
    onattach: [],
    values: undefined,
  },
  {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      return undefined;
    },
  },
);

stub = new Proxy(
  function pluginSdkStub() {
    return stub;
  },
  {
    apply() {
      return stub;
    },
    construct() {
      return stub;
    },
    get(target, prop, receiver) {
      if (prop === "__esModule") {
        return true;
      }
      if (prop === "default") {
        return stub;
      }
      if (prop === "then") {
        return undefined;
      }
      if (prop === "_zod") {
        return stubZodMeta;
      }
      if (prop === "arguments" || prop === "caller") {
        return undefined;
      }
      if (prop === Symbol.toPrimitive) {
        return () => "";
      }
      if (prop === "toJSON") {
        return () => undefined;
      }
      if (prop === "toString") {
        return () => "";
      }
      if (prop === "valueOf") {
        return () => 0;
      }
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      return stub;
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), "__esModule", "default"])];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "__esModule") {
        return {
          configurable: true,
          enumerable: false,
          value: true,
          writable: false,
        };
      }
      if (prop === "default") {
        return {
          configurable: true,
          enumerable: false,
          value: stub,
          writable: false,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  },
);

module.exports = stub;
