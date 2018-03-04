import ENTRY from "./constant/entry.js"
import SOURCE_TYPE from "./constant/source-type.js"

import GenericArray from "./generic/array.js"
import OwnProxy from "./own/proxy.js"
import Package from "./package.js"

import assign from "./util/assign.js"
import copyProperty from "./util/copy-property.js"
import errors from "./errors.js"
import getModuleName from "./util/get-module-name.js"
import has from "./util/has.js"
import isObjectLike from "./util/is-object-like.js"
import keys from "./util/keys.js"
import proxyExports from "./util/proxy-exports.js"
import setDeferred from "./util/set-deferred.js"
import setGetter from "./util/set-getter.js"
import setSetter from "./util/set-setter.js"
import shared from "./shared.js"
import warn from "./warn.js"

const {
  LOAD,
  MODE,
  STATE
} = ENTRY

const {
  MODULE
} = SOURCE_TYPE

const {
  ERR_EXPORT_MISSING,
  ERR_EXPORT_STAR_CONFLICT
} = errors

const GETTER_ERROR = { __proto__: null }
const STAR_ERROR = { __proto__: null }

const pseudoDescriptor = {
  __proto__: null,
  value: true
}

const toStringTagDescriptor = {
  __proto__: null,
  value: "Module"
}

class Entry {
  constructor(mod) {
    // The namespace object change indicator.
    this._changed = false
    // The loading state of the module.
    this._loaded = LOAD.INCOMPLETE
    // The raw namespace object without proxied exports.
    this._namespace = { __proto__: null }
    // The load mode for `module.require`.
    this._requireESM = false
    // The builtin module indicator.
    this.builtin = false
    // The cache file name of the module.
    this.cacheName = null
    // The child entries of the module.
    this.children = { __proto__: null }
    // The namespace object which may have proxied exports.
    this.namespace = this._namespace
    // The namespace object CJS importers receive.
    this.cjsNamespace = this.namespace
    // The namespace object ESM importers receive.
    this.esmNamespace = this.namespace
    // The temporary store of the initial `module.exports` value.
    this.exports = null
    // Getters for local variables exported by the module.
    this.getters = { __proto__: null }
    // The unique id for the module cache.
    this.id = null
    // The module the entry is managing.
    this.module = mod
    // The name of the module.
    this.name = getModuleName(mod)
    // The package data of the module.
    this.package = Package.from(mod)
    // The `module.parent` entry.
    this.parent = null
    // The name of the runtime identifier.
    this.runtimeName = null
    // Setters for assigning to local variables in parent modules.
    this.setters = { __proto__: null }
    // Initialize empty namespace setter so they are merged properly.
    this.setters["*"] = []
    // The state of the module:
    this.state = STATE.INITIAL
    // The file url of the module.
    this.url = null

    setGetter(this, "compileData", () =>
      this.package.cache.compile[this.cacheName]
    )

    setSetter(this, "compileData", (value) => {
      this.package.cache.compile[this.cacheName] = value
    })

    setGetter(this, "mode", () => {
      const { compileData } = this

      if (compileData &&
          compileData !== true) {
        return this.mode = compileData.sourceType === MODULE
          ? MODE.ESM
          : MODE.CJS
      }

      return "cjs"
    })

    setSetter(this, "mode", (value) => {
      Reflect.defineProperty(this, "mode", {
        __proto__: null,
        configurable: true,
        enumerable: true,
        value,
        writable: true
      })
    })
  }

  static delete(value) {
    if (isObjectLike(value)) {
      shared.entry.cache.delete(value)
    }
  }

  static get(mod) {
    if (! mod) {
      return null
    }

    const { cache, skipExports } = shared.entry
    const name = getModuleName(mod)

    let exported
    let useExports = false

    if (! skipExports[name]) {
      exported = mod.exports
      useExports = isObjectLike(exported)
    }

    let entry = cache.get(useExports ? exported : mod)

    if (! entry &&
        useExports) {
      entry = cache.get(mod)
    }

    if (! entry) {
      entry = new Entry(mod)
      Entry.set(mod, entry)
      Entry.set(exported, entry)
    }

    return entry
  }

  static has(value) {
    return isObjectLike(value) &&
      shared.entry.cache.has(value)
  }

  static set(value, entry) {
    if (isObjectLike(value)) {
      shared.entry.cache.set(value, entry)
    }
  }

  addGetter(name, getter) {
    getter.owner = this
    this.getters[name] = getter
    return this
  }

  addGetters(getterPairs) {
    for (const [name, getter] of getterPairs) {
      this.addGetter(name, getter)
    }

    return this
  }

  addGettersFrom(otherEntry) {
    const { getters, name } = this
    const { getters:otherGetters } = otherEntry

    for (const key in otherEntry._namespace) {
      if (key === "default") {
        continue
      }

      let getter = getters[key]
      const otherGetter = otherGetters[key]

      if (typeof getter !== "function" &&
          typeof otherGetter === "function") {
        getter = otherGetter
        getters[key] = getter
      }

      if (this.mode === MODE.ESM ||
          typeof getter !== "function" ||
          typeof otherGetter !== "function") {
        continue
      }

      const ownerName = getter.owner.name

      if (ownerName !== name &&
          ownerName !== otherGetter.owner.name) {
        this.addGetter(key, () => STAR_ERROR)
      }
    }

    return this
  }

  addSetter(name, setter, parent) {
    const setters = this.setters[name] || (this.setters[name] = [])
    setter.last = { __proto__: null }
    setter.parent = parent
    GenericArray.push(setters, setter)
    return this
  }

  addSetters(setterPairs, parent) {
    for (const [name, setter] of setterPairs) {
      this.addSetter(name, setter, parent)
    }

    return this
  }

  loaded() {
    if (this._loaded !== LOAD.INCOMPLETE) {
      return this._loaded
    }

    if (! this.module.loaded) {
      return this._loaded = LOAD.INCOMPLETE
    }

    this._loaded = LOAD.INDETERMINATE

    const { children } = this

    for (const id in children) {
      if (children[id].loaded() === LOAD.INCOMPLETE) {
        return this._loaded = LOAD.INCOMPLETE
      }
    }

    const isESM = this.mode === MODE.ESM

    let setNsGetters = true
    let exported = this.module.exports

    if (isESM &&
        ! Object.isSealed(exported)) {
      if (this.package.options.cjs.interop &&
          ! has(this._namespace, "__esModule")) {
        Reflect.defineProperty(exported, "__esModule", pseudoDescriptor)
      }

      for (const name in this._namespace) {
        setGetter(exported, name, () => this._namespace[name])
      }

      Object.seal(exported)
    } else if (! isESM) {
      const oldMod = this.module
      const oldExported = oldMod.exports
      const newEntry = Entry.get(this.module)

      setNsGetters = newEntry._loaded !== LOAD.COMPLETED

      this.merge(newEntry)

      const newMod = this.module
      const newExported = newMod.exports

      if (newMod !== oldMod) {
        Entry.delete(oldMod, this)
        Entry.set(newMod, this)
      }

      if (newExported !== oldExported) {
        Entry.delete(oldExported, this)
        Entry.set(newExported, this)
      }

      if (! newMod.loaded) {
        return this._loaded = LOAD.INCOMPLETE
      }
    }

    assignExportsToNamespace(this)

    if (setNsGetters) {
      setDeferred(this, "cjsNamespace", () =>
        toNamespace(this, { default: this.module.exports })
      )

      setDeferred(this, "esmNamespace", () => toNamespace(this))
    }

    Reflect.deleteProperty(shared.entry.skipExports, this.name)
    return this._loaded = LOAD.COMPLETED
  }

  merge(otherEntry) {
    if (otherEntry !== this) {
      for (const key in otherEntry) {
        mergeProperty(this, otherEntry, key)
      }
    }

    return this
  }

  update() {
    // Lazily-initialized mapping of parent module identifiers to parent
    // module objects whose setters we might need to run.
    let parentsMap

    this._changed = false

    runGetters(this)
    runSetters(this, (setter, value) => {
      parentsMap || (parentsMap = { __proto__: null })
      parentsMap[setter.parent.name] = setter.parent
      setter(value, this)
    })

    this._changed = false

    // If any of the setters updated the bindings of a parent module,
    // or updated local variables that are exported by that parent module,
    // then we must re-run any setters registered by that parent module.
    for (const id in parentsMap) {
      // What happens if `parents[parentIDs[id]] === module`, or if
      // longer cycles exist in the parent chain? Thanks to our `setter.last`
      // bookkeeping in `changed()`, the `entry.update()` broadcast will only
      // proceed as far as there are any actual changes to report.
      parentsMap[id].update()
    }

    return this
  }
}

function assignExportsToNamespace(entry) {
  const { _namespace, getters } = entry
  const exported = entry.module.exports
  const isESM = entry.mode === MODE.ESM
  const object = entry._loaded === LOAD.COMPLETED ? _namespace : exported

  const isPseudo =
    entry.package.options.cjs.interop &&
    has(exported, "__esModule") &&
    !! exported.__esModule

  const skipDefault =
    ! isESM &&
    ! (isPseudo && has(object, "default"))

  if (skipDefault) {
    _namespace.default = exported

    if (! Reflect.has(entry.getters, "default")) {
      entry.addGetter("default", () => entry.namespace.default)

      entry.namespace = new OwnProxy(_namespace, {
        get(target, name, receiver) {
          const value = Reflect.get(target, name, receiver)

          if (name === "default" &&
              isObjectLike(value)) {
            return proxyExports(entry)
          }

          return value
        }
      })
    }
  }

  if (! isObjectLike(exported)) {
    return
  }

  const names = keys(object)

  for (const name of names) {
    if (isESM) {
      _namespace[name] = exported[name]
    } else if (! (skipDefault && name === "default") &&
        ! has(_namespace, name)) {
      setGetter(_namespace, name, () => exported[name])

      setSetter(_namespace, name, (value) => {
        exported[name] = value
      })
    }

    if (! (name in getters)) {
      entry.addGetter(name, () => entry._namespace[name])
    }
  }
}

function callGetter(getter) {
  try {
    return getter()
  } catch (e) {}

  return GETTER_ERROR
}

function changed(setter, key, value) {
  const { last } = setter

  if (Object.is(last[key], value)) {
    return false
  }

  last[key] = value
  return true
}

function createNamespace() {
  // Section 9.4.6: Module Namespace Exotic Objects
  // Module namespace objects have a null [[Prototype]].
  // https://tc39.github.io/ecma262/#sec-module-namespace-exotic-objects
  const namespace = { __proto__: null }

  // Section 26.3.1: @@toStringTag
  // Module namespace objects have a @@toStringTag value of "Module".
  // https://tc39.github.io/ecma262/#sec-@@tostringtag
  Reflect.defineProperty(namespace, Symbol.toStringTag, toStringTagDescriptor)

  return namespace
}

function getExportByName(entry, setter, name) {
  const isESM = entry.mode === MODE.ESM

  const isScript =
    ! isESM &&
    ! setter.parent.package.options.cjs.namedExports

  if (name === "*") {
    return isScript ? entry.cjsNamespace : entry.esmNamespace
  }

  if (isESM) {
    return entry.namespace[name]
  }

  if ((isScript &&
       name !== "default") ||
      (entry._loaded === LOAD.COMPLETED &&
       ! (name in entry.getters))) {
    // Remove problematic setter to unblock subsequent imports.
    Reflect.deleteProperty(entry.setters, name)
    throw new ERR_EXPORT_MISSING(entry.module, name)
  }

  const value = entry.namespace[name]

  if (value === STAR_ERROR) {
    throw new ERR_EXPORT_STAR_CONFLICT(entry.module, name)
  }

  return value
}

function mergeProperty(entry, otherEntry, key) {
  if ((entry._loaded !== LOAD.INCOMPLETE ||
       otherEntry._loaded !== LOAD.INCOMPLETE) &&
      (key === "cjsNamespace" ||
       key === "esmNamespace")) {
    return copyProperty(entry, otherEntry, key)
  }

  const value = otherEntry[key]

  if (key !== "setters") {
    if (key === "children") {
      assign(entry.children, value)
    } else if (key === "getters") {
      for (const name in value) {
        entry.addGetter(name, value[name])
      }
    } else if (key ===  "_loaded"
        ? value > entry._loaded
        : value != null) {
      entry[key] = value
    }

    return entry
  }

  const settersMap = entry.setters

  for (const name in value) {
    const setters = settersMap[name]
    const otherSetters = settersMap[name] = value[name]

    for (const setter of setters) {
      if (GenericArray.indexOf(otherSetters, setter) === -1) {
        GenericArray.push(otherSetters, setter)
      }
    }
  }

  return entry
}

function runGetter(entry, name) {
  const { _namespace } = entry
  const value = callGetter(entry.getters[name])

  if (value !== GETTER_ERROR &&
      ! (name in _namespace &&
         Object.is(_namespace[name], value))) {
    entry._changed = true
    _namespace[name] = value
  }
}

function runGetters(entry) {
  if (entry.mode === MODE.ESM) {
    for (const name in entry.getters) {
      runGetter(entry, name)
    }
  } else {
    assignExportsToNamespace(entry)
  }
}

function runSetter(entry, name, callback) {
  const { children, compileData, getters } = entry
  const nsChanged = name === "*" && entry._changed

  for (const setter of entry.setters[name]) {
    const force = nsChanged && setter.from === "nsSetter"
    const value = force ? void 0 : getExportByName(entry, setter, name)

    if (force ||
        changed(setter, name, value)) {
      callback(setter, value)
    } else if (value === void 0 &&
        name in getters &&
        setter.parent.name in children &&
        compileData.exportTemporals.indexOf(name) !== -1) {
      warn("WRN_TDZ_ACCESS", entry.module, name)
    }
  }
}

function runSetters(entry, callback) {
  for (const name in entry.setters) {
    runSetter(entry, name, callback)
  }
}

function toNamespace(entry, source = entry.namespace) {
  const names = keys(source).sort()
  const namespace = createNamespace()

  // Section 9.4.6: Module Namespace Exotic Objects
  // Properties should be assigned in `Array#sort` order.
  // https://tc39.github.io/ecma262/#sec-module-namespace-exotic-objects
  for (const name of names) {
    namespace[name] = void 0
  }

  return new OwnProxy(Object.seal(namespace), {
    get: (namespace, name) => {
      return name === Symbol.toStringTag
        ? Reflect.get(namespace, name)
        : Reflect.get(source, name)
    },
    getOwnPropertyDescriptor: (namespace, name) => {
      if (! Reflect.has(namespace, name)) {
        return
      }

      const descriptor = {
        configurable: false,
        enumerable: false,
        value: "Module",
        writable: false
      }

      // Section 26.3.1: @@toStringTag
      // Return descriptor of the module namespace @@toStringTag.
      // https://tc39.github.io/ecma262/#sec-@@tostringtag
      if (name === Symbol.toStringTag) {
        return descriptor
      }

      // Section 9.4.6: Module Namespace Exotic Objects
      // Return descriptor of the non-extensible module namespace property.
      // https://tc39.github.io/ecma262/#sec-module-namespace-exotic-objects
      descriptor.enumerable =
      descriptor.writable = true
      descriptor.value = Reflect.get(source, name)

      return descriptor
    },
    set: (namespace, name) => {
      if (entry.package.options.warnings) {
        if (Reflect.has(source, name)) {
          warn("WRN_NS_ASSIGNMENT", entry.module, name)
        } else {
          warn("WRN_NS_EXTENSION", entry.module, name)
        }
      }

      return true
    }
  })
}

Reflect.setPrototypeOf(Entry.prototype, null)

export default Entry
