/**
 * A Writer knows how to take a stream of tokens and render them to a
 * string, given a context. It also maintains a cache of templates to
 * avoid the need to parse the same template twice.
 */
function Writer () {
  this.templateCache = {
    _cache: {},
    set: function set (key, value) {
      this._cache[key] = value
    },
    get: function get (key) {
      return this._cache[key]
    },
    clear: function clear () {
      this._cache = {}
    }
  }
}

/**
 * Clears all cached templates in this writer.
 */
Writer.prototype.clearCache = function clearCache () {
  if (typeof this.templateCache !== 'undefined') {
    this.templateCache.clear()
  }
}

/**
 * Parses and caches the given `template` according to the given `tags` or
 * `mustache.tags` if `tags` is omitted,  and returns the array of tokens
 * that is generated from the parse.
 */
Writer.prototype.parse = function parse (template, tags) {
  var cache = this.templateCache
  var cacheKey = template + ':' + (tags || mustache.tags).join(':')
  var isCacheEnabled = typeof cache !== 'undefined'
  var tokens = isCacheEnabled ? cache.get(cacheKey) : undefined

  if (tokens == undefined) {
    tokens = parseTemplate(template, tags)
    isCacheEnabled && cache.set(cacheKey, tokens)
  }
  return tokens
}

/**
 * High-level method that is used to render the given `template` with
 * the given `view`.
 *
 * The optional `partials` argument may be an object that contains the
 * names and templates of partials that are used in the template. It may
 * also be a function that is used to load partial templates on the fly
 * that takes a single argument: the name of the partial.
 *
 * If the optional `config` argument is given here, then it should be an
 * object with a `tags` attribute or an `escape` attribute or both.
 * If an array is passed, then it will be interpreted the same way as
 * a `tags` attribute on a `config` object.
 *
 * The `tags` attribute of a `config` object must be an array with two
 * string values: the opening and closing tags used in the template (e.g.
 * [ "<%", "%>" ]). The default is to mustache.tags.
 *
 * The `escape` attribute of a `config` object must be a function which
 * accepts a string as input and outputs a safely escaped string.
 * If an `escape` function is not provided, then an HTML-safe string
 * escaping function is used as the default.
 */
Writer.prototype.render = function render (template, view, partials, config) {
  var tags = this.getConfigTags(config)
  var tokens = this.parse(template, tags)
  var context = (view instanceof Context) ? view : new Context(view, undefined)
  return this.renderTokens(tokens, context, partials, template, config)
}

/**
 * Low-level method that renders the given array of `tokens` using
 * the given `context` and `partials`.
 *
 * Note: The `originalTemplate` is only ever used to extract the portion
 * of the original template that was contained in a higher-order section.
 * If the template doesn't use higher-order sections, this argument may
 * be omitted.
 */
Writer.prototype.renderTokens = function renderTokens (tokens, context, partials, originalTemplate, config) {
  var buffer = ''

  var token, symbol, value
  for (var i = 0, numTokens = tokens.length; i < numTokens; ++i) {
    value = undefined
    token = tokens[i]
    symbol = token[0]

    if (symbol === '#') value = this.renderSection(token, context, partials, originalTemplate, config)
    else if (symbol === '^') value = this.renderInverted(token, context, partials, originalTemplate, config)
    else if (symbol === '>') value = this.renderPartial(token, context, partials, config)
    else if (symbol === '&') value = this.unescapedValue(token, context)
    else if (symbol === 'name') value = this.escapedValue(token, context, config)
    else if (symbol === 'text') value = this.rawValue(token)

    if (value !== undefined)
      buffer += value
  }

  return buffer
}

Writer.prototype.renderSection = function renderSection (token, context, partials, originalTemplate, config) {
  var self = this
  var buffer = ''
  var value = context.lookup(token[1])

  // This function is used to render an arbitrary template
  // in the current context by higher-order sections.
  function subRender (template) {
    return self.render(template, context, partials, config)
  }

  if (!value) return

  if (isArray(value)) {
    for (var j = 0, valueLength = value.length; j < valueLength; ++j) {
      buffer += this.renderTokens(token[4], context.push(value[j]), partials, originalTemplate, config)
    }
  } else if (typeof value === 'object' || typeof value === 'string' || typeof value === 'number') {
    buffer += this.renderTokens(token[4], context.push(value), partials, originalTemplate, config)
  } else if (isFunction(value)) {
    if (typeof originalTemplate !== 'string')
      throw new Error('Cannot use higher-order sections without the original template')

    // Extract the portion of the original template that the section contains.
    value = value.call(context.view, originalTemplate.slice(token[3], token[5]), subRender)

    if (value != null)
      buffer += value
  } else {
    buffer += this.renderTokens(token[4], context, partials, originalTemplate, config)
  }
  return buffer
}

Writer.prototype.renderInverted = function renderInverted (token, context, partials, originalTemplate, config) {
  var value = context.lookup(token[1])

  // Use JavaScript's definition of falsy. Include empty arrays.
  // See https://github.com/janl/mustache.js/issues/186
  if (!value || (isArray(value) && value.length === 0))
    return this.renderTokens(token[4], context, partials, originalTemplate, config)
}

Writer.prototype.indentPartial = function indentPartial (partial, indentation, lineHasNonSpace) {
  var filteredIndentation = indentation.replace(/[^ \t]/g, '')
  var partialByNl = partial.split('\n')
  for (var i = 0; i < partialByNl.length; i++) {
    if (partialByNl[i].length && (i > 0 || !lineHasNonSpace)) {
      partialByNl[i] = filteredIndentation + partialByNl[i]
    }
  }
  return partialByNl.join('\n')
}

Writer.prototype.renderPartial = function renderPartial (token, context, partials, config) {
  if (!partials) return
  var tags = this.getConfigTags(config)

  var value = isFunction(partials) ? partials(token[1]) : partials[token[1]]
  if (value != null) {
    var lineHasNonSpace = token[6]
    var tagIndex = token[5]
    var indentation = token[4]
    var indentedValue = value
    if (tagIndex == 0 && indentation) {
      indentedValue = this.indentPartial(value, indentation, lineHasNonSpace)
    }
    var tokens = this.parse(indentedValue, tags)
    return this.renderTokens(tokens, context, partials, indentedValue, config)
  }
}

Writer.prototype.unescapedValue = function unescapedValue (token, context) {
  var value = context.lookup(token[1])
  if (value != null)
    return value
}

Writer.prototype.escapedValue = function escapedValue (token, context, config) {
  var escape = this.getConfigEscape(config) || mustache.escape
  var value = context.lookup(token[1])
  if (value != null)
    return (typeof value === 'number' && escape === mustache.escape) ? String(value) : escape(value)
}

Writer.prototype.rawValue = function rawValue (token) {
  return token[1]
}

Writer.prototype.getConfigTags = function getConfigTags (config) {
  if (isArray(config)) {
    return config
  }
  else if (config && typeof config === 'object') {
    return config.tags
  }
  else {
    return undefined
  }
}

Writer.prototype.getConfigEscape = function getConfigEscape (config) {
  if (config && typeof config === 'object' && !isArray(config)) {
    return config.escape
  }
  else {
    return undefined
  }
}