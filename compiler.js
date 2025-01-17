/* jshint quotmark: single */

(function () {
    'use strict';

    exports.generate = function (inputFilename, options) {
        var compiler = new Compiler();
        return compiler.generate(inputFilename, __dirname, options);
    };

    exports.getJs = function (input) {
        var compiler = new Compiler();
        return compiler.process(input, __dirname);
    };

    var _ = require('underscore');
    var path = require('path');
    var fs = require('fs');
    var glob = require('glob');
    var marked = require('marked');
    var crypto = require('crypto');

    var autoSectionCount = 0;

    var packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json')).toString());
    var squiffyVersion = packageJson.version;

    String.prototype.format = function () {
        var args = arguments;
        return this.replace(/{(\d+)}/g, function (match, number) {
            return typeof args[number] != 'undefined' ? args[number] : match;
        });
    };

    String.prototype.endsWith = function (suffix) {
        return this.indexOf(suffix, this.length - suffix.length) !== -1;
    };

    function Compiler() {
        this.process = function (input, sourcePath) {
            var story = new Story();
            var success = this.processFileText(story, input, null, null, null, true);
            if (!success) return 'Failed';
            return this.getJs(story, sourcePath, {});
        };

        this.generate = function (inputFilename, sourcePath, options) {
            var outputPath;
            if (options.write) {
                outputPath = path.resolve(path.dirname(inputFilename));
            }

            var story = new Story();
            if (inputFilename) {
                story.set_id(path.resolve(inputFilename));
            }
            else {
                story.set_id(options.input);
            }

            var success;
            if (inputFilename) {
                success = this.processFile(story, path.resolve(inputFilename), outputPath, true);
            }
            else {
                success = this.processFileText(story, options.input, null, null, null, true);
            }

            if (!success) {
                console.log('Failed.');
                return;
            }

            var storyJsName = typeof options.scriptOnly === 'string' ? options.scriptOnly : 'story.js';

            console.log('Writing ' + storyJsName);

            var storyJs = this.getJs(story, sourcePath, options);

            if (options.write) {
                fs.writeFileSync(path.join(outputPath, storyJsName), storyJs);
            }

            if (!options.scriptOnly) {
                console.log('Writing index.html');

                var htmlTemplateFile = fs.readFileSync(this.findFile('index.template.html', outputPath, sourcePath));
                var htmlData = htmlTemplateFile.toString();
                htmlData = htmlData.replace('<!-- INFO -->', '<!--\n\nCreated with Squiffy {0}\n\n\nhttps://github.com/textadventures/squiffy\n\n-->'.format(squiffyVersion));
                htmlData = htmlData.replace('<!-- TITLE -->', story.title);
                var jQueryPath = "";
                if (typeof options.escritorio !== "undefined")
                    jQueryPath = path.join(sourcePath, '..', 'jquery', 'dist', 'jquery.min.js');
                else
                    jQueryPath = path.join(sourcePath, 'node_modules', 'jquery', 'dist', 'jquery.min.js');
                var jqueryJs = 'jquery.min.js';
                if (options.useCdn) {
                    var jqueryVersion = packageJson.dependencies.jquery.match(/[0-9.]+/)[0];
                    jqueryJs = `https://ajax.aspnetcdn.com/ajax/jquery/jquery-${jqueryVersion}.min.js`;
                }
                else if (options.write) {
                    fs.createReadStream(jQueryPath).pipe(fs.createWriteStream(path.join(outputPath, 'jquery.min.js')));
                }

                htmlData = htmlData.replace('<!-- JQUERY -->', jqueryJs);

                var scriptData = _.map(story.scripts, function (script) { return '<script src="{0}"></script>'.format(script); }).join('\n');
                htmlData = htmlData.replace('<!-- SCRIPTS -->', scriptData);

                var stylesheetData = _.map(story.stylesheets, function (sheet) { return '<link rel="stylesheet" href="{0}"/>'.format(sheet); }).join('\n');
                htmlData = htmlData.replace('<!-- STYLESHEETS -->', stylesheetData);

                if (options.write) {
                    fs.writeFileSync(path.join(outputPath, 'index.html'), htmlData);
                }

                console.log('Writing style.css');

                var cssTemplateFile = fs.readFileSync(this.findFile('style.template.css', outputPath, sourcePath));
                var cssData = cssTemplateFile.toString();

                if (options.write) {
                    fs.writeFileSync(path.join(outputPath, 'style.css'), cssData);
                }

                if (options.zip) {
                    console.log('Creating zip file');
                    var JSZip = require('jszip');
                    var zip = new JSZip();
                    zip.file(storyJsName, storyJs);
                    zip.file('index.html', htmlData);
                    zip.file('style.css', cssData);
                    if (!options.useCdn) {
                        var jquery = fs.readFileSync(jQueryPath);
                        zip.file(jqueryJs, jquery);
                    }
                    var buffer = zip.generate({
                        type: 'nodebuffer'
                    });
                    if (options.write) {
                        fs.writeFileSync(path.join(outputPath, 'output.zip'), buffer);
                    }
                    else {
                        return buffer;
                    }
                }
            }

            console.log('Done.');

            return outputPath;
        };

        this.getJs = function (story, sourcePath, options) {
            var jsTemplateFile = fs.readFileSync(path.join(sourcePath, 'squiffy.template.js'));
            var jsData = '// Created with Squiffy {0}\n// https://github.com/textadventures/squiffy\n\n'
                .format(squiffyVersion) +
                '(function(){\n' +
                jsTemplateFile.toString();

            if (options.scriptOnly && options.pluginName) {
                jsData = jsData.replace('jQuery.fn.squiffy =', 'jQuery.fn.' + options.pluginName + ' =');
            }

            var outputJsFile = [];
            outputJsFile.push(jsData);
            outputJsFile.push('\n\n');
            if (!story.start) {
                story.start = Object.keys(story.sections)[0];
            }
            outputJsFile.push('squiffy.story.start = \'' + story.start + '\';\n');
            if (story.id) {
                outputJsFile.push('squiffy.story.id = \'{0}\';\n'.format(story.id));
            }
            outputJsFile.push('squiffy.story.sections = {\n');

            _.each(story.sections, function (section, sectionName) {
                outputJsFile.push('\t\'{0}\': {\n'.format(sectionName.replace(/\'/g, "\\'")));
                if (section.clear) {
                    outputJsFile.push('\t\t\'clear\': true,\n');
                }
                outputJsFile.push('\t\t\'text\': {0},\n'.format(JSON.stringify(this.processText(section.text.join('\n'), story, section, null))));
                if (section.attributes.length > 0) {
                    outputJsFile.push('\t\t\'attributes\': {0},\n'.format(JSON.stringify(section.attributes)));
                }
                if (section.js.length > 0) {
                    this.writeJs(outputJsFile, 2, section.js);
                }
                if ('@last' in section.passages) {
                    var passageCount = 0;
                    _.each(section.passages, function (passage, passageName) {
                        if (passageName && passageName.substr(0, 1) !== '@') {
                            passageCount++;
                        }
                    });
                    outputJsFile.push('\t\t\'passageCount\': ' + passageCount + ',\n');
                }

                outputJsFile.push('\t\t\'passages\': {\n');
                _.each(section.passages, function (passage, passageName) {
                    outputJsFile.push('\t\t\t\'{0}\': {\n'.format(passageName.replace(/\'/g, "\\'")));
                    if (passage.clear) {
                        outputJsFile.push('\t\t\t\t\'clear\': true,\n');
                    }
                    outputJsFile.push('\t\t\t\t\'text\': {0},\n'.format(JSON.stringify(this.processText(passage.text.join('\n'), story, section, passage))));
                    if (passage.attributes.length > 0) {
                        outputJsFile.push('\t\t\t\t\'attributes\': {0},\n'.format(JSON.stringify(passage.attributes)));
                    }
                    if (passage.js.length > 0) {
                        this.writeJs(outputJsFile, 4, passage.js);
                    }
                    outputJsFile.push('\t\t\t},\n');
                }, this);

                outputJsFile.push('\t\t},\n');
                outputJsFile.push('\t},\n');
            }, this);

            outputJsFile.push('}\n');
            outputJsFile.push('})();');

            return outputJsFile.join('');
        };

        this.findFile = function (filename, outputPath, sourcePath) {
            if (outputPath) {
                var outputPathFile = path.join(outputPath, filename);
                if (fs.existsSync(outputPathFile)) {
                    return outputPathFile;
                }
            }
            return path.join(sourcePath, filename);
        };

        this.regex = {
            section: /^\[\[(.*)\]\]:$/,
            passage: /^\[(.*)\]:$/,
            title: /^@title (.*)$/,
            import: /^@import (.*)$/,
            start: /^@start (.*)$/,
            attributes: /^@set (.*)$/,
            unset: /^@unset (.*)$/,
            inc: /^@inc (\S+)(?: (\d+))?$/,
            dec: /^@dec (\S+)(?: (\d+))?$/,
            replace: /^@replace (.*$)/,
            js: /^(\t| {4})(.*)$/,
            continue: /^\+\+\+(.*)$/,
        };

        this.processFile = function (story, inputFilename, basePath, isFirst) {
            if (_.contains(story.files, inputFilename)) {
                return true;
            }

            story.files.push(inputFilename);
            //console.log('Loading ' + inputFilename);

            var inputFile = fs.readFileSync(inputFilename);
            var inputText = inputFile.toString();

            //console.log('basePath: {0}'.format(basePath));
            var localPackage = inputFilename.split(path.sep).join(path.posix.sep);
            //console.log('localPackage: {0}'.format(localPackage));
            if (localPackage.startsWith(basePath.split(path.sep).join(path.posix.sep))) {
                //console.log('localPackage startsWith');
                localPackage = localPackage.slice(basePath.split(path.sep).join(path.posix.sep).length);
            }
            //console.log('localPackage: {0}'.format(localPackage));
            localPackage = localPackage.replace(/\.squiffy$/, '');
            //console.log('localPackage: {0}'.format(localPackage));
            if (!localPackage.startsWith('/')) {
                localPackage = '/' + localPackage;
            }
            if (!localPackage.endsWith('/')) {
                localPackage = localPackage + '/';
            }
            //console.log('localPackage: {0}'.format(localPackage));

            return this.processFileText(story, inputText, inputFilename, basePath, localPackage, isFirst);
        };

        this.processFileText = function (story, inputText, inputFilename, globalBasePath, localPackage, isFirst) {
            var inputLines = inputText.replace(/\r/g, '').split('\n');

            var compiler = this;
            var lineCount = 0;
            var section = null;
            var passage = null;
            var textStarted = false;
            var ensureSectionExists = function () {
                section = compiler.ensureSectionExists(story, section, isFirst, inputFilename, lineCount);
            };

            console.log('INFO: processing file {0}; package: {1}'.format(inputFilename, localPackage));

            return inputLines.every(function (line) {
                var stripLine = line.trim();
                lineCount++;

                //console.log('TRACE: processing line {0}'.format(stripLine));

                var match = _.object(_.map(this.regex, function (regex, key) {
                    return [key, key == 'js' ? regex.exec(line) : regex.exec(stripLine)];
                }));

                if (match.section) {
                    var section_id = match.section[1];
                    //console.log(section_id);
                    if (!section_id.startsWith('/')) {
                        section_id = localPackage + section_id;
                    }

                    section = story.addSection(section_id, inputFilename, lineCount, localPackage);
                    passage = null;
                    textStarted = false;
                }
                else if (match.passage) {
                    if (!section) {
                        console.log('ERROR: {0} line {1}: Can\'t add passage "{2}" as no section has been created.'.format(
                            inputFilename, lineCount, match.passage[1]));
                        return false;
                    }

                    passage = section.addPassage(match.passage[1], lineCount);
                    textStarted = false;
                }
                else if (match.continue) {
                    ensureSectionExists();
                    autoSectionCount++;
                    var autoSectionName = localPackage + '_continue{0}'.format(autoSectionCount);
                    section.addText('[[{0}]]({1})'.format(match.continue[1], autoSectionName));
                    section = story.addSection(autoSectionName, inputFilename, lineCount, localPackage);
                    passage = null;
                    textStarted = false;
                }
                else if (stripLine == '@clear') {
                    if (!passage) {
                        ensureSectionExists();
                        section.clear = true;
                    }
                    else {
                        passage.clear = true;
                    }
                }
                else if (match.title) {
                    story.title = match.title[1];
                }
                else if (match.start) {
                    var start_id = match.start[1];
                    //console.log(start_id);
                    if (!start_id.startsWith('/')) {
                        start_id = localPackage + start_id;
                    }

                    story.start = start_id;
                }
                else if (match.import && inputFilename) {
                    //console.log('TRACE: processing import statement in file {0}'.format(inputFilename));
                    var basePath = path.resolve(path.dirname(inputFilename));
                    var newFilenames = path.join(basePath, match.import[1]);
                    newFilenames = newFilenames.split(path.sep).join(path.posix.sep);
                    //console.log('TRACE: import filenames (unresolved) {0}'.format(newFilenames));
                    var importFilenames = glob.sync(newFilenames);
                    //console.log('TRACE: import filenames (resolved) {0}'.format(importFilenames));
                    //console.log(importFilenames);
                    importFilenames.every(function (importFilename) {
                        //console.log('INFO: importing file {0}'.format(importFilename));
                        if (importFilename.endsWith('.squiffy')) {
                            var success = this.processFile(story, importFilename, globalBasePath, localPackage, false);
                            if (!success) return false;
                        }
                        else if (importFilename.endsWith('.js')) {
                            story.scripts.push(path.relative(basePath, importFilename));
                        }
                        else if (importFilename.endsWith('.css')) {
                            story.stylesheets.push(path.relative(basePath, importFilename));
                        }

                        return true;
                    }, this);
                }
                else if (match.attributes) {
                    section = this.addAttribute(match.attributes[1], story, section, passage, isFirst, inputFilename, lineCount);
                }
                else if (match.unset) {
                    section = this.addAttribute('not ' + match.unset[1], story, section, passage, isFirst, inputFilename, lineCount);
                }
                else if (match.inc) {
                    section = this.addAttribute(match.inc[1] + '+=' + (match.inc[2] === undefined ? '1' : match.inc[2]), story, section, passage, isFirst, inputFilename, lineCount);
                }
                else if (match.dec) {
                    section = this.addAttribute(match.dec[1] + '-=' + (match.dec[2] === undefined ? '1' : match.dec[2]), story, section, passage, isFirst, inputFilename, lineCount);
                }
                else if (match.replace) {
                    var replaceAttribute = match.replace[1];
                    var attributeMatch = /^(.*?)=(.*)$/.exec(replaceAttribute);
                    if (attributeMatch) {
                        replaceAttribute = attributeMatch[1] + '=' + this.processText(attributeMatch[2]);
                    }
                    section = this.addAttribute('@replace ' + replaceAttribute, story, section, passage, isFirst, inputFilename, lineCount);
                }
                else if (!textStarted && match.js) {
                    if (!passage) {
                        ensureSectionExists();
                        section.addJS(match.js[2]);
                    }
                    else {
                        passage.addJS(match.js[2]);
                    }
                }
                else if (textStarted || stripLine.length > 0) {
                    if (!passage) {
                        ensureSectionExists();
                        if (section) {
                            section.addText(line);
                            textStarted = true;
                        }
                    }
                    else {
                        passage.addText(line);
                        textStarted = true;
                    }
                }

                return true;
            }, this);
        };

        this.ensureSectionExists = function (story, section, isFirst, inputFilename, lineCount) {
            if (!section && isFirst) {
                section = story.addSection('_default', inputFilename, lineCount);
            }
            return section;
        };

        this.addAttribute = function (attribute, story, section, passage, isFirst, inputFilename, lineCount) {
            if (!passage) {
                section = this.ensureSectionExists(story, section, isFirst, inputFilename, lineCount);
                section.addAttribute(attribute);
            }
            else {
                passage.addAttribute(attribute);
            }
            return section;
        };

        this.processText = function (input, story, section, passage) {
            //console.log('input: {0}'.format(input));

            // fix local links first
            var namedSectionLocalLinkRegex = /\[\[([^\]]*?)\]\]\(([^\/].*?)\)/g;
            input = input.replace(namedSectionLocalLinkRegex, '[[$1]](' + section.localPackage + '$2)');

            var unnamedSectionLocalLinkRegex = /\[\[([^\/].*?)\]\]([^\(]|$)/g;
            input = input.replace(unnamedSectionLocalLinkRegex, '[[$1]](' + section.localPackage + '$1)$2');

            //console.log('fixed input: {0}'.format(input));

            // namedSectionLinkRegex matches:
            //   open [[
            //   any text - the link text
            //   closing ]]
            //   open bracket
            //   any text - the name of the section
            //   closing bracket
            var namedSectionLinkRegex = /\[\[([^\]]*?)\]\]\((.*?)\)/g;

            var links = this.allMatchesForGroup(input, namedSectionLinkRegex, 2);
            this.checkSectionLinks(story, links, section, passage);

            input = input.replace(namedSectionLinkRegex, '<a class="squiffy-link link-section" data-section="$2" role="link" tabindex="0">$1</a>');

            // namedPassageLinkRegex matches:
            //   open [
            //   any text - the link text
            //   closing ]
            //   open bracket, but not http(s):// after it
            //   any text - the name of the passage
            //   closing bracket
            var namedPassageLinkRegex = /\[([^\]]*?)\]\(((?!https?:\/\/).*?)\)/g;

            links = this.allMatchesForGroup(input, namedPassageLinkRegex, 2);
            this.checkPassageLinks(story, links, section, passage);

            input = input.replace(namedPassageLinkRegex, '<a class="squiffy-link link-passage" data-passage="$2" role="link" tabindex="0">$1</a>');

            // unnamedSectionLinkRegex matches:
            //   open [[
            //   any text - the link text
            //   closing ]]
            var unnamedSectionLinkRegex = /\[\[(.*?)\]\]/g;

            links = this.allMatchesForGroup(input, unnamedSectionLinkRegex, 1);
            this.checkSectionLinks(story, links, section, passage);

            input = input.replace(unnamedSectionLinkRegex, '<a class="squiffy-link link-section" data-section="$1" role="link" tabindex="0">$1</a>');

            // unnamedPassageLinkRegex matches:
            //   open [
            //   any text - the link text
            //   closing ]
            //   no bracket after
            var unnamedPassageLinkRegex = /\[(.*?)\]([^\(]|$)/g;

            links = this.allMatchesForGroup(input, unnamedPassageLinkRegex, 1);
            this.checkPassageLinks(story, links, section, passage);

            input = input.replace(unnamedPassageLinkRegex, '<a class="squiffy-link link-passage" data-passage="$1" role="link" tabindex="0">$1</a>$2');

            return marked.parse(input).trim();
        };

        this.allMatchesForGroup = function (input, regex, groupNumber) {
            var result = [];
            var match;
            while (!!(match = regex.exec(input))) {
                result.push(match[groupNumber]);
            }
            return result;
        };

        this.checkSectionLinks = function (story, links, section, passage) {
            if (!story) return;
            var badLinks = _.filter(links, function (m) { return !this.linkDestinationExists(m, story.sections); }, this);
            this.showBadLinksWarning(badLinks, 'section', '[[', ']]', section, passage);
        };

        this.checkPassageLinks = function (story, links, section, passage) {
            if (!story) return;
            var badLinks = _.filter(links, function (m) { return !this.linkDestinationExists(m, section.passages); }, this);
            this.showBadLinksWarning(badLinks, 'passage', '[', ']', section, passage);
        };

        this.linkDestinationExists = function (link, keys) {
            // Link destination data may look like:
            //   passageName
            //   passageName, my_attribute=2
            //   passageName, @replace 1=new text, some_attribute=5
            //   @replace 2=some words
            // We're only interested in checking if the named passage or section exists.

            var linkDestination = link.split(',')[0];
            if (linkDestination.substr(0, 1) == '@') {
                return true;
            }
            return _.contains(Object.keys(keys), linkDestination);
        };

        this.showBadLinksWarning = function (badLinks, linkTo, before, after, section, passage) {
            badLinks.forEach(function (badLink) {
                var warning;
                if (!passage) {
                    warning = '{0} line {1}: In section \'{2}\''.format(section.filename, section.line, section.name);
                }
                else {
                    warning = '{0} line {1}: In section \'{2}\', passage \'{3}\''.format(
                        section.filename, passage.line, section.name, passage.name);
                }
                console.log('WARNING: {0} there is a link to a {1} called {2}{3}{4}, which doesn\'t exist'.format(warning, linkTo, before, badLink, after));
            });
        };

        this.writeJs = function (outputJsFile, tabCount, js) {
            var tabs = new Array(tabCount + 1).join('\t');
            outputJsFile.push('{0}\'js\': function() {\n'.format(tabs));
            js.forEach(function (jsLine) {
                outputJsFile.push('{0}\t{1}\n'.format(tabs, jsLine));
            });
            outputJsFile.push('{0}},\n'.format(tabs));
        };
    }

    function Story() {
        this.sections = {};
        this.title = '';
        this.scripts = [];
        this.stylesheets = [];
        this.files = [];
        this.start = '';

        this.addSection = function (name, filename, line, localPackage) {
            if (name in this.sections) {
                console.log('WARNING: {0} line {1}: Section [[{2}]] was declared already'.format(filename, line, name));
            }

            var section = new Section(name, filename, line, localPackage);
            this.sections[name] = section;
            return section;
        };

        this.set_id = function (filename) {
            var shasum = crypto.createHash('sha1');
            shasum.update(filename);
            this.id = shasum.digest('hex').substr(0, 10);
        };
    }

    function Section(name, filename, line, localPackage) {
        this.name = name;
        this.filename = filename;
        this.line = line;
        this.text = [];
        this.passages = {};
        this.js = [];
        this.clear = false;
        this.attributes = [];
        this.localPackage = localPackage;

        this.addPassage = function (name, line) {
            var passage = new Passage(name, line, this.localPackage);
            this.passages[name] = passage;
            return passage;
        };

        this.addText = function (text) {
            this.text.push(text);
        };

        this.addJS = function (text) {
            this.js.push(text);
        };

        this.addAttribute = function (text) {
            this.attributes.push(text);
        };
    }

    function Passage(name, line, localPackage) {
        this.name = name;
        this.line = line;
        this.text = [];
        this.js = [];
        this.clear = false;
        this.attributes = [];
        this.localPackage = this.localPackage;

        this.addText = function (text) {
            this.text.push(text);
        };

        this.addJS = function (text) {
            this.js.push(text);
        };

        this.addAttribute = function (text) {
            this.attributes.push(text);
        };
    }
})();