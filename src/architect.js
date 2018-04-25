"use strict";
/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@angular-devkit/core");
const node_1 = require("@angular-devkit/core/node");
const rxjs_1 = require("rxjs");
const operators_1 = require("rxjs/operators");
class ProjectNotFoundException extends core_1.BaseException {
    constructor(projectName) {
        super(`Project '${projectName}' could not be found in Workspace.`);
    }
}
exports.ProjectNotFoundException = ProjectNotFoundException;
class TargetNotFoundException extends core_1.BaseException {
    constructor(projectName, targetName) {
        super(`Target '${targetName}' could not be found in project '${projectName}'.`);
    }
}
exports.TargetNotFoundException = TargetNotFoundException;
class ConfigurationNotFoundException extends core_1.BaseException {
    constructor(projectName, configurationName) {
        super(`Configuration '${configurationName}' could not be found in project '${projectName}'.`);
    }
}
exports.ConfigurationNotFoundException = ConfigurationNotFoundException;
// TODO: break this exception apart into more granular ones.
class BuilderCannotBeResolvedException extends core_1.BaseException {
    constructor(builder) {
        super(`Builder '${builder}' cannot be resolved.`);
    }
}
exports.BuilderCannotBeResolvedException = BuilderCannotBeResolvedException;
class ArchitectNotYetLoadedException extends core_1.BaseException {
    constructor() { super(`Architect needs to be loaded before Architect is used.`); }
}
exports.ArchitectNotYetLoadedException = ArchitectNotYetLoadedException;
class BuilderNotFoundException extends core_1.BaseException {
    constructor(builder) {
        super(`Builder ${builder} could not be found.`);
    }
}
exports.BuilderNotFoundException = BuilderNotFoundException;
class Architect {
    constructor(_workspace) {
        this._workspace = _workspace;
        this._targetsSchemaPath = core_1.join(core_1.normalize(__dirname), 'targets-schema.json');
        this._buildersSchemaPath = core_1.join(core_1.normalize(__dirname), 'builders-schema.json');
        this._architectSchemasLoaded = false;
        this._targetMapMap = new Map();
        this._builderPathsMap = new Map();
        this._builderDescriptionMap = new Map();
        this._builderConstructorMap = new Map();
    }
    loadArchitect() {
        if (this._architectSchemasLoaded) {
            return rxjs_1.of(this);
        }
        else {
            return rxjs_1.forkJoin(this._loadJsonFile(this._targetsSchemaPath), this._loadJsonFile(this._buildersSchemaPath)).pipe(operators_1.concatMap(([targetsSchema, buildersSchema]) => {
                this._targetsSchema = targetsSchema;
                this._buildersSchema = buildersSchema;
                this._architectSchemasLoaded = true;
                // Validate and cache all project target maps.
                return rxjs_1.forkJoin(...this._workspace.listProjectNames().map(projectName => {
                    const unvalidatedTargetMap = this._workspace.getProjectArchitect(projectName);
                    return this._workspace.validateAgainstSchema(unvalidatedTargetMap, this._targetsSchema).pipe(operators_1.tap(targetMap => this._targetMapMap.set(projectName, targetMap)));
                }));
            }), operators_1.map(() => this));
        }
    }
    listProjectTargets(projectName) {
        return Object.keys(this._getProjectTargetMap(projectName));
    }
    _getProjectTargetMap(projectName) {
        if (!this._targetMapMap.has(projectName)) {
            throw new ProjectNotFoundException(projectName);
        }
        return this._targetMapMap.get(projectName);
    }
    _getProjectTarget(projectName, targetName) {
        const targetMap = this._getProjectTargetMap(projectName);
        const target = targetMap[targetName];
        if (!target) {
            throw new TargetNotFoundException(projectName, targetName);
        }
        return target;
    }
    getBuilderConfiguration(targetSpec) {
        const { project: projectName, target: targetName, configuration: configurationName, overrides, } = targetSpec;
        const project = this._workspace.getProject(projectName);
        const target = this._getProjectTarget(projectName, targetName);
        const options = target.options;
        let configuration = {};
        if (configurationName) {
            if (!target.configurations) {
                throw new ConfigurationNotFoundException(projectName, configurationName);
            }
            configuration = target.configurations[configurationName];
            if (!configuration) {
                throw new ConfigurationNotFoundException(projectName, configurationName);
            }
        }
        const builderConfiguration = {
            root: project.root,
            projectType: project.projectType,
            builder: target.builder,
            options: Object.assign({}, options, configuration, overrides),
        };
        return builderConfiguration;
    }
    run(builderConfig, partialContext = {}) {
        const context = Object.assign({ logger: new core_1.logging.NullLogger(), architect: this, host: this._workspace.host, workspace: this._workspace }, partialContext);
        let builderDescription;
        return this.getBuilderDescription(builderConfig).pipe(operators_1.tap(description => builderDescription = description), operators_1.concatMap(() => this.validateBuilderOptions(builderConfig, builderDescription)), operators_1.tap(validatedBuilderConfig => builderConfig = validatedBuilderConfig), operators_1.map(() => this.getBuilder(builderDescription, context)), operators_1.concatMap(builder => builder.run(builderConfig)));
    }
    getBuilderDescription(builderConfig) {
        // Check cache for this builder description.
        if (this._builderDescriptionMap.has(builderConfig.builder)) {
            return rxjs_1.of(this._builderDescriptionMap.get(builderConfig.builder));
        }
        return new rxjs_1.Observable((obs) => {
            // TODO: this probably needs to be more like NodeModulesEngineHost.
            const basedir = core_1.getSystemPath(this._workspace.root);
            const [pkg, builderName] = builderConfig.builder.split(':');
            const pkgJsonPath = node_1.resolve(pkg, { basedir, resolvePackageJson: true, checkLocal: true });
            let buildersJsonPath;
            let builderPaths;
            // Read the `builders` entry of package.json.
            return this._loadJsonFile(core_1.normalize(pkgJsonPath)).pipe(operators_1.concatMap((pkgJson) => {
                const pkgJsonBuildersentry = pkgJson['builders'];
                if (!pkgJsonBuildersentry) {
                    return rxjs_1.throwError(new BuilderCannotBeResolvedException(builderConfig.builder));
                }
                buildersJsonPath = core_1.join(core_1.dirname(core_1.normalize(pkgJsonPath)), pkgJsonBuildersentry);
                return this._loadJsonFile(buildersJsonPath);
            }), 
            // Validate builders json.
            operators_1.concatMap((builderPathsMap) => this._workspace.validateAgainstSchema(builderPathsMap, this._buildersSchema)), operators_1.concatMap((builderPathsMap) => {
                builderPaths = builderPathsMap.builders[builderName];
                if (!builderPaths) {
                    return rxjs_1.throwError(new BuilderCannotBeResolvedException(builderConfig.builder));
                }
                // Resolve paths in the builder paths.
                const builderJsonDir = core_1.dirname(buildersJsonPath);
                builderPaths.schema = core_1.join(builderJsonDir, builderPaths.schema);
                builderPaths.class = core_1.join(builderJsonDir, builderPaths.class);
                // Save the builder paths so that we can lazily load the builder.
                this._builderPathsMap.set(builderConfig.builder, builderPaths);
                // Load the schema.
                return this._loadJsonFile(builderPaths.schema);
            }), operators_1.map(builderSchema => {
                const builderDescription = {
                    name: builderConfig.builder,
                    schema: builderSchema,
                    description: builderPaths.description,
                };
                // Save to cache before returning.
                this._builderDescriptionMap.set(builderDescription.name, builderDescription);
                return builderDescription;
            })).subscribe(obs);
        });
    }
    validateBuilderOptions(builderConfig, builderDescription) {
        return this._workspace.validateAgainstSchema(builderConfig.options, builderDescription.schema).pipe(operators_1.map(validatedOptions => {
            builderConfig.options = validatedOptions;
            return builderConfig;
        }));
    }
    getBuilder(builderDescription, context) {
        const name = builderDescription.name;
        let builderConstructor;
        // Check cache for this builder.
        if (this._builderConstructorMap.has(name)) {
            builderConstructor = this._builderConstructorMap.get(name);
        }
        else {
            if (!this._builderPathsMap.has(name)) {
                throw new BuilderNotFoundException(name);
            }
            const builderPaths = this._builderPathsMap.get(name);
            // TODO: support more than the default export, maybe via builder#import-name.
            const builderModule = require(core_1.getSystemPath(builderPaths.class));
            builderConstructor = builderModule['default'];
            // Save builder to cache before returning.
            this._builderConstructorMap.set(builderDescription.name, builderConstructor);
        }
        const builder = new builderConstructor(context);
        return builder;
    }
    _loadJsonFile(path) {
        return this._workspace.host.read(core_1.normalize(path)).pipe(operators_1.map(buffer => core_1.virtualFs.fileBufferToString(buffer)), operators_1.map(str => core_1.parseJson(str, core_1.JsonParseMode.Loose)));
    }
}
exports.Architect = Architect;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXJjaGl0ZWN0LmpzIiwic291cmNlUm9vdCI6Ii4vIiwic291cmNlcyI6WyJwYWNrYWdlcy9hbmd1bGFyX2RldmtpdC9hcmNoaXRlY3Qvc3JjL2FyY2hpdGVjdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7OztHQU1HOztBQUVILCtDQWE4QjtBQUM5QixvREFBbUU7QUFDbkUsK0JBQTREO0FBQzVELDhDQUFxRDtBQVdyRCw4QkFBc0MsU0FBUSxvQkFBYTtJQUN6RCxZQUFZLFdBQW1CO1FBQzdCLEtBQUssQ0FBQyxZQUFZLFdBQVcsb0NBQW9DLENBQUMsQ0FBQztJQUNyRSxDQUFDO0NBQ0Y7QUFKRCw0REFJQztBQUVELDZCQUFxQyxTQUFRLG9CQUFhO0lBQ3hELFlBQVksV0FBbUIsRUFBRSxVQUFrQjtRQUNqRCxLQUFLLENBQUMsV0FBVyxVQUFVLG9DQUFvQyxXQUFXLElBQUksQ0FBQyxDQUFDO0lBQ2xGLENBQUM7Q0FDRjtBQUpELDBEQUlDO0FBRUQsb0NBQTRDLFNBQVEsb0JBQWE7SUFDL0QsWUFBWSxXQUFtQixFQUFFLGlCQUF5QjtRQUN4RCxLQUFLLENBQUMsa0JBQWtCLGlCQUFpQixvQ0FBb0MsV0FBVyxJQUFJLENBQUMsQ0FBQztJQUNoRyxDQUFDO0NBQ0Y7QUFKRCx3RUFJQztBQUVELDREQUE0RDtBQUM1RCxzQ0FBOEMsU0FBUSxvQkFBYTtJQUNqRSxZQUFZLE9BQWU7UUFDekIsS0FBSyxDQUFDLFlBQVksT0FBTyx1QkFBdUIsQ0FBQyxDQUFDO0lBQ3BELENBQUM7Q0FDRjtBQUpELDRFQUlDO0FBRUQsb0NBQTRDLFNBQVEsb0JBQWE7SUFDL0QsZ0JBQWdCLEtBQUssQ0FBQyx3REFBd0QsQ0FBQyxDQUFDLENBQUMsQ0FBQztDQUNuRjtBQUZELHdFQUVDO0FBRUQsOEJBQXNDLFNBQVEsb0JBQWE7SUFDekQsWUFBWSxPQUFlO1FBQ3pCLEtBQUssQ0FBQyxXQUFXLE9BQU8sc0JBQXNCLENBQUMsQ0FBQztJQUNsRCxDQUFDO0NBQ0Y7QUFK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QyxJQUFJLENBQUMsQ0FBQztZQUMzQyxDQUFDO1lBRUQsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQWlCLENBQUM7WUFFckUsNkVBQTZFO1lBQzdFLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxvQkFBYSxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO1lBQ2pFLGtCQUFrQixHQUFHLGFBQWEsQ0FBQyxTQUFTLENBQWlDLENBQUM7WUFFOUUsMENBQTBDO1lBQzFDLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxHQUFHLENBQUMsa0JBQWtCLENBQUMsSUFBSSxFQUFFLGtCQUFrQixDQUFDLENBQUM7UUFDL0UsQ0FBQztRQUVELE1BQU0sT0FBTyxHQUFHLElBQUksa0JBQWtCLENBQUMsT0FBTyxDQUFDLENBQUM7UUFFaEQsTUFBTSxDQUFDLE9BQU8sQ0FBQztJQUNqQixDQUFDO0lBRU8sYUFBYSxDQUFDLElBQVU7UUFDOUIsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxnQkFBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUNwRCxlQUFHLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxnQkFBUyxDQUFDLGtCQUFrQixDQUFDLE1BQU0sQ0FBQyxDQUFDLEVBQ25ELGVBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLGdCQUFTLENBQUMsR0FBRyxFQUFFLG9CQUFhLENBQUMsS0FBSyxDQUFxQixDQUFDLENBQ3BFLENBQUM7SUFDSixDQUFDO0NBQ0Y7QUFuUEQsOEJBbVBDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBAbGljZW5zZVxuICogQ29weXJpZ2h0IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG4gKlxuICogVXNlIG9mIHRoaXMgc291cmNlIGNvZGUgaXMgZ292ZXJuZWQgYnkgYW4gTUlULXN0eWxlIGxpY2Vuc2UgdGhhdCBjYW4gYmVcbiAqIGZvdW5kIGluIHRoZSBMSUNFTlNFIGZpbGUgYXQgaHR0cHM6Ly9hbmd1bGFyLmlvL2xpY2Vuc2VcbiAqL1xuXG5pbXBvcnQge1xuICBCYXNlRXhjZXB0aW9uLFxuICBKc29uT2JqZWN0LFxuICBKc29uUGFyc2VNb2RlLFxuICBQYXRoLFxuICBkaXJuYW1lLFxuICBleHBlcmltZW50YWwsXG4gIGdldFN5c3RlbVBhdGgsXG4gIGpvaW4sXG4gIGxvZ2dpbmcsXG4gIG5vcm1hbGl6ZSxcbiAgcGFyc2VKc29uLFxuICB2aXJ0dWFsRnMsXG59IGZyb20gJ0Bhbmd1bGFyLWRldmtpdC9jb3JlJztcbmltcG9ydCB7IHJlc29sdmUgYXMgbm9kZVJlc29sdmUgfSBmcm9tICdAYW5ndWxhci1kZXZraXQvY29yZS9ub2RlJztcbmltcG9ydCB7IE9ic2VydmFibGUsIGZvcmtKb2luLCBvZiwgdGhyb3dFcnJvciB9IGZyb20gJ3J4anMnO1xuaW1wb3J0IHsgY29uY2F0TWFwLCBtYXAsIHRhcCB9IGZyb20gJ3J4anMvb3BlcmF0b3JzJztcbmltcG9ydCB7XG4gIEJ1aWxkRXZlbnQsXG4gIEJ1aWxkZXIsXG4gIEJ1aWxkZXJDb25zdHJ1Y3RvcixcbiAgQnVpbGRlckNvbnRleHQsXG4gIEJ1aWxkZXJEZXNjcmlwdGlvbixcbiAgQnVpbGRlclBhdGhzLFxuICBCdWlsZGVyUGF0aHNNYXAsXG59IGZyb20gJy4vYnVpbGRlcic7XG5cbmV4cG9ydCBjbGFzcyBQcm9qZWN0Tm90Rm91bmRFeGNlcHRpb24gZXh0ZW5kcyBCYXNlRXhjZXB0aW9uIHtcbiAgY29uc3RydWN0b3IocHJvamVjdE5hbWU6IHN0cmluZykge1xuICAgIHN1cGVyKGBQcm9qZWN0ICcke3Byb2plY3ROYW1lfScgY291bGQgbm90IGJlIGZvdW5kIGluIFdvcmtzcGFjZS5gKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgVGFyZ2V0Tm90Rm91bmRFeGNlcHRpb24gZXh0ZW5kcyBCYXNlRXhjZXB0aW9uIHtcbiAgY29uc3RydWN0b3IocHJvamVjdE5hbWU6IHN0cmluZywgdGFyZ2V0TmFtZTogc3RyaW5nKSB7XG4gICAgc3VwZXIoYFRhcmdldCAnJHt0YXJnZXROYW1lfScgY291bGQgbm90IGJlIGZvdW5kIGluIHByb2plY3QgJyR7cHJvamVjdE5hbWV9Jy5gKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgQ29uZmlndXJhdGlvbk5vdEZvdW5kRXhjZXB0aW9uIGV4dGVuZHMgQmFzZUV4Y2VwdGlvbiB7XG4gIGNvbnN0cnVjdG9yKHByb2plY3ROYW1lOiBzdHJpbmcsIGNvbmZpZ3VyYXRpb25OYW1lOiBzdHJpbmcpIHtcbiAgICBzdXBlcihgQ29uZmlndXJhdGlvbiAnJHtjb25maWd1cmF0aW9uTmFtZX0nIGNvdWxkIG5vdCBiZSBmb3VuZCBpbiBwcm9qZWN0ICcke3Byb2plY3ROYW1lfScuYCk7XG4gIH1cbn1cblxuLy8gVE9ETzogYnJlYWsgdGhpcyBleGNlcHRpb24gYXBhcnQgaW50byBtb3JlIGdyYW51bGFyIG9uZXMuXG5leHBvcnQgY2xhc3MgQnVpbGRlckNhbm5vdEJlUmVzb2x2ZWRFeGNlcHRpb24gZXh0ZW5kcyBCYXNlRXhjZXB0aW9uIHtcbiAgY29uc3RydWN0b3IoYnVpbGRlcjogc3RyaW5nKSB7XG4gICAgc3VwZXIoYEJ1aWxkZXIgJyR7YnVpbGRlcn0nIGNhbm5vdCBiZSByZXNvbHZlZC5gKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgQXJjaGl0ZWN0Tm90WWV0TG9hZGVkRXhjZXB0aW9uIGV4dGVuZHMgQmFzZUV4Y2VwdGlvbiB7XG4gIGNvbnN0cnVjdG9yKCkgeyBzdXBlcihgQXJjaGl0ZWN0IG5lZWRzIHRvIGJlIGxvYWRlZCBiZWZvcmUgQXJjaGl0ZWN0IGlzIHVzZWQuYCk7IH1cbn1cblxuZXhwb3J0IGNsYXNzIEJ1aWxkZXJOb3RGb3VuZEV4Y2VwdGlvbiBleHRlbmRzIEJhc2VFeGNlcHRpb24ge1xuICBjb25zdHJ1Y3RvcihidWlsZGVyOiBzdHJpbmcpIHtcbiAgICBzdXBlcihgQnVpbGRlciAke2J1aWxkZXJ9IGNvdWxkIG5vdCBiZSBmb3VuZC5gKTtcbiAgfVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIEJ1aWxkZXJDb25maWd1cmF0aW9uPE9wdGlvbnNUID0ge30+IHtcbiAgcm9vdDogUGF0aDtcbiAgcHJvamVjdFR5cGU6IHN0cmluZztcbiAgYnVpbGRlcjogc3RyaW5nO1xuICBvcHRpb25zOiBPcHRpb25zVDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUYXJnZXRTcGVjaWZpZXI8T3B0aW9uc1QgPSB7fT4ge1xuICBwcm9qZWN0OiBzdHJpbmc7XG4gIHRhcmdldDogc3RyaW5nO1xuICBjb25maWd1cmF0aW9uPzogc3RyaW5nO1xuICBvdmVycmlkZXM/OiBQYXJ0aWFsPE9wdGlvbnNUPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUYXJnZXRNYXAge1xuICBbazogc3RyaW5nXTogVGFyZ2V0O1xufVxuXG5leHBvcnQgZGVjbGFyZSB0eXBlIFRhcmdldE9wdGlvbnM8VCA9IEpzb25PYmplY3Q+ID0gVDtcbmV4cG9ydCBkZWNsYXJlIHR5cGUgVGFyZ2V0Q29uZmlndXJhdGlvbjxUID0gSnNvbk9iamVjdD4gPSBQYXJ0aWFsPFQ+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFRhcmdldDxUID0gSnNvbk9iamVjdD4ge1xuICBidWlsZGVyOiBzdHJpbmc7XG4gIG9wdGlvbnM6IFRhcmdldE9wdGlvbnM8VD47XG4gIGNvbmZpZ3VyYXRpb25zPzogeyBbazogc3RyaW5nXTogVGFyZ2V0Q29uZmlndXJhdGlvbjxUPiB9O1xufVxuXG5leHBvcnQgY2xhc3MgQXJjaGl0ZWN0IHtcbiAgcHJpdmF0ZSByZWFkb25seSBfdGFyZ2V0c1NjaGVtYVBhdGggPSBqb2luKG5vcm1hbGl6ZShfX2Rpcm5hbWUpLCAndGFyZ2V0cy1zY2hlbWEuanNvbicpO1xuICBwcml2YXRlIHJlYWRvbmx5IF9idWlsZGVyc1NjaGVtYVBhdGggPSBqb2luKG5vcm1hbGl6ZShfX2Rpcm5hbWUpLCAnYnVpbGRlcnMtc2NoZW1hLmpzb24nKTtcbiAgcHJpdmF0ZSBfdGFyZ2V0c1NjaGVtYTogSnNvbk9iamVjdDtcbiAgcHJpdmF0ZSBfYnVpbGRlcnNTY2hlbWE6IEpzb25PYmplY3Q7XG4gIHByaXZhdGUgX2FyY2hpdGVjdFNjaGVtYXNMb2FkZWQgPSBmYWxzZTtcbiAgcHJpdmF0ZSBfdGFyZ2V0TWFwTWFwID0gbmV3IE1hcDxzdHJpbmcsIFRhcmdldE1hcD4oKTtcbiAgcHJpdmF0ZSBfYnVpbGRlclBhdGhzTWFwID0gbmV3IE1hcDxzdHJpbmcsIEJ1aWxkZXJQYXRocz4oKTtcbiAgcHJpdmF0ZSBfYnVpbGRlckRlc2NyaXB0aW9uTWFwID0gbmV3IE1hcDxzdHJpbmcsIEJ1aWxkZXJEZXNjcmlwdGlvbj4oKTtcbiAgcHJpdmF0ZSBfYnVpbGRlckNvbnN0cnVjdG9yTWFwID0gbmV3IE1hcDxzdHJpbmcsIEJ1aWxkZXJDb25zdHJ1Y3Rvcjx7fT4+KCk7XG5cbiAgY29uc3RydWN0b3IocHJpdmF0ZSBfd29ya3NwYWNlOiBleHBlcmltZW50YWwud29ya3NwYWNlLldvcmtzcGFjZSkgeyB9XG5cbiAgbG9hZEFyY2hpdGVjdCgpIHtcbiAgICBpZiAodGhpcy5fYXJjaGl0ZWN0U2NoZW1hc0xvYWRlZCkge1xuICAgICAgcmV0dXJuIG9mKHRoaXMpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gZm9ya0pvaW4oXG4gICAgICAgIHRoaXMuX2xvYWRKc29uRmlsZSh0aGlzLl90YXJnZXRzU2NoZW1hUGF0aCksXG4gICAgICAgIHRoaXMuX2xvYWRKc29uRmlsZSh0aGlzLl9idWlsZGVyc1NjaGVtYVBhdGgpLFxuICAgICAgKS5waXBlKFxuICAgICAgICBjb25jYXRNYXAoKFt0YXJnZXRzU2NoZW1hLCBidWlsZGVyc1NjaGVtYV0pID0+IHtcbiAgICAgICAgICB0aGlzLl90YXJnZXRzU2NoZW1hID0gdGFyZ2V0c1NjaGVtYTtcbiAgICAgICAgICB0aGlzLl9idWlsZGVyc1NjaGVtYSA9IGJ1aWxkZXJzU2NoZW1hO1xuICAgICAgICAgIHRoaXMuX2FyY2hpdGVjdFNjaGVtYXNMb2FkZWQgPSB0cnVlO1xuXG4gICAgICAgICAgLy8gVmFsaWRhdGUgYW5kIGNhY2hlIGFsbCBwcm9qZWN0IHRhcmdldCBtYXBzLlxuICAgICAgICAgIHJldHVybiBmb3JrSm9pbihcbiAgICAgICAgICAgIC4uLnRoaXMuX3dvcmtzcGFjZS5saXN0UHJvamVjdE5hbWVzKCkubWFwKHByb2plY3ROYW1lID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgdW52YWxpZGF0ZWRUYXJnZXRNYXAgPSB0aGlzLl93b3Jrc3BhY2UuZ2V0UHJvamVjdEFyY2hpdGVjdChwcm9qZWN0TmFtZSk7XG5cbiAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dvcmtzcGFjZS52YWxpZGF0ZUFnYWluc3RTY2hlbWE8VGFyZ2V0TWFwPihcbiAgICAgICAgICAgICAgICB1bnZhbGlkYXRlZFRhcmdldE1hcCwgdGhpcy5fdGFyZ2V0c1NjaGVtYSkucGlwZShcbiAgICAgICAgICAgICAgICAgIHRhcCh0YXJnZXRNYXAgPT4gdGhpcy5fdGFyZ2V0TWFwTWFwLnNldChwcm9qZWN0TmFtZSwgdGFyZ2V0TWFwKSksXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICApO1xuICAgICAgICB9KSxcbiAgICAgICAgbWFwKCgpID0+IHRoaXMpLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBsaXN0UHJvamVjdFRhcmdldHMocHJvamVjdE5hbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gT2JqZWN0LmtleXModGhpcy5fZ2V0UHJvamVjdFRhcmdldE1hcChwcm9qZWN0TmFtZSkpO1xuICB9XG5cbiAgcHJpdmF0ZSBfZ2V0UHJvamVjdFRhcmdldE1hcChwcm9qZWN0TmFtZTogc3RyaW5nKTogVGFyZ2V0TWFwIHtcbiAgICBpZiAoIXRoaXMuX3RhcmdldE1hcE1hcC5oYXMocHJvamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgUHJvamVjdE5vdEZvdW5kRXhjZXB0aW9uKHByb2plY3ROYW1lKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fdGFyZ2V0TWFwTWFwLmdldChwcm9qZWN0TmFtZSkgYXMgVGFyZ2V0TWFwO1xuICB9XG5cbiAgcHJpdmF0ZSBfZ2V0UHJvamVjdFRhcmdldDxUID0ge30+KHByb2plY3ROYW1lOiBzdHJpbmcsIHRhcmdldE5hbWU6IHN0cmluZyk6IFRhcmdldDxUPiB7XG4gICAgY29uc3QgdGFyZ2V0TWFwID0gdGhpcy5fZ2V0UHJvamVjdFRhcmdldE1hcChwcm9qZWN0TmFtZSk7XG5cbiAgICBjb25zdCB0YXJnZXQgPSB0YXJnZXRNYXBbdGFyZ2V0TmFtZV0gYXMge30gYXMgVGFyZ2V0PFQ+O1xuXG4gICAgaWYgKCF0YXJnZXQpIHtcbiAgICAgIHRocm93IG5ldyBUYXJnZXROb3RGb3VuZEV4Y2VwdGlvbihwcm9qZWN0TmFtZSwgdGFyZ2V0TmFtZSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRhcmdldDtcbiAgfVxuXG4gIGdldEJ1aWxkZXJDb25maWd1cmF0aW9uPE9wdGlvbnNUPih0YXJnZXRTcGVjOiBUYXJnZXRTcGVjaWZpZXIpOiBCdWlsZGVyQ29uZmlndXJhdGlvbjxPcHRpb25zVD4ge1xuICAgIGNvbnN0IHtcbiAgICAgIHByb2plY3Q6IHByb2plY3ROYW1lLFxuICAgICAgdGFyZ2V0OiB0YXJnZXROYW1lLFxuICAgICAgY29uZmlndXJhdGlvbjogY29uZmlndXJhdGlvbk5hbWUsXG4gICAgICBvdmVycmlkZXMsXG4gICAgfSA9IHRhcmdldFNwZWM7XG5cbiAgICBjb25zdCBwcm9qZWN0ID0gdGhpcy5fd29ya3NwYWNlLmdldFByb2plY3QocHJvamVjdE5hbWUpO1xuICAgIGNvbnN0IHRhcmdldCA9IHRoaXMuX2dldFByb2plY3RUYXJnZXQocHJvamVjdE5hbWUsIHRhcmdldE5hbWUpO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB0YXJnZXQub3B0aW9ucztcbiAgICBsZXQgY29uZmlndXJhdGlvbjogVGFyZ2V0Q29uZmlndXJhdGlvbiA9IHt9O1xuXG4gICAgaWYgKGNvbmZpZ3VyYXRpb25OYW1lKSB7XG4gICAgICBpZiAoIXRhcmdldC5jb25maWd1cmF0aW9ucykge1xuICAgICAgICB0aHJvdyBuZXcgQ29uZmlndXJhdGlvbk5vdEZvdW5kRXhjZXB0aW9uKHByb2plY3ROYW1lLCBjb25maWd1cmF0aW9uTmFtZSk7XG4gICAgICB9XG5cbiAgICAgIGNvbmZpZ3VyYXRpb24gPSB0YXJnZXQuY29uZmlndXJhdGlvbnNbY29uZmlndXJhdGlvbk5hbWVdO1xuXG4gICAgICBpZiAoIWNvbmZpZ3VyYXRpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IENvbmZpZ3VyYXRpb25Ob3RGb3VuZEV4Y2VwdGlvbihwcm9qZWN0TmFtZSwgY29uZmlndXJhdGlvbk5hbWUpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGJ1aWxkZXJDb25maWd1cmF0aW9uOiBCdWlsZGVyQ29uZmlndXJhdGlvbjxPcHRpb25zVD4gPSB7XG4gICAgICByb290OiBwcm9qZWN0LnJvb3QgYXMgUGF0aCxcbiAgICAgIHByb2plY3RUeXBlOiBwcm9qZWN0LnByb2plY3RUeXBlLFxuICAgICAgYnVpbGRlcjogdGFyZ2V0LmJ1aWxkZXIsXG4gICAgICBvcHRpb25zOiB7XG4gICAgICAgIC4uLm9wdGlvbnMsXG4gICAgICAgIC4uLmNvbmZpZ3VyYXRpb24sXG4gICAgICAgIC4uLm92ZXJyaWRlcyBhcyB7fSxcbiAgICAgIH0gYXMgT3B0aW9uc1QsXG4gICAgfTtcblxuICAgIHJldHVybiBidWlsZGVyQ29uZmlndXJhdGlvbjtcbiAgfVxuXG4gIHJ1bjxPcHRpb25zVD4oXG4gICAgYnVpbGRlckNvbmZpZzogQnVpbGRlckNvbmZpZ3VyYXRpb248T3B0aW9uc1Q+LFxuICAgIHBhcnRpYWxDb250ZXh0OiBQYXJ0aWFsPEJ1aWxkZXJDb250ZXh0PiA9IHt9LFxuICApOiBPYnNlcnZhYmxlPEJ1aWxkRXZlbnQ+IHtcbiAgICBjb25zdCBjb250ZXh0OiBCdWlsZGVyQ29udGV4dCA9IHtcbiAgICAgIGxvZ2dlcjogbmV3IGxvZ2dpbmcuTnVsbExvZ2dlcigpLFxuICAgICAgYXJjaGl0ZWN0OiB0aGlzLFxuICAgICAgaG9zdDogdGhpcy5fd29ya3NwYWNlLmhvc3QsXG4gICAgICB3b3Jrc3BhY2U6IHRoaXMuX3dvcmtzcGFjZSxcbiAgICAgIC4uLnBhcnRpYWxDb250ZXh0LFxuICAgIH07XG5cbiAgICBsZXQgYnVpbGRlckRlc2NyaXB0aW9uOiBCdWlsZGVyRGVzY3JpcHRpb247XG5cbiAgICByZXR1cm4gdGhpcy5nZXRCdWlsZGVyRGVzY3JpcHRpb24oYnVpbGRlckNvbmZpZykucGlwZShcbiAgICAgIHRhcChkZXNjcmlwdGlvbiA9PiBidWlsZGVyRGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbiksXG4gICAgICBjb25jYXRNYXAoKCkgPT4gdGhpcy52YWxpZGF0ZUJ1aWxkZXJPcHRpb25zKGJ1aWxkZXJDb25maWcsIGJ1aWxkZXJEZXNjcmlwdGlvbikpLFxuICAgICAgdGFwKHZhbGlkYXRlZEJ1aWxkZXJDb25maWcgPT4gYnVpbGRlckNvbmZpZyA9IHZhbGlkYXRlZEJ1aWxkZXJDb25maWcpLFxuICAgICAgbWFwKCgpID0+IHRoaXMuZ2V0QnVpbGRlcihidWlsZGVyRGVzY3JpcHRpb24sIGNvbnRleHQpKSxcbiAgICAgIGNvbmNhdE1hcChidWlsZGVyID0+IGJ1aWxkZXIucnVuKGJ1aWxkZXJDb25maWcpKSxcbiAgICApO1xuICB9XG5cbiAgZ2V0QnVpbGRlckRlc2NyaXB0aW9uPE9wdGlvbnNUPihcbiAgICBidWlsZGVyQ29uZmlnOiBCdWlsZGVyQ29uZmlndXJhdGlvbjxPcHRpb25zVD4sXG4gICk6IE9ic2VydmFibGU8QnVpbGRlckRlc2NyaXB0aW9uPiB7XG4gICAgLy8gQ2hlY2sgY2FjaGUgZm9yIHRoaXMgYnVpbGRlciBkZXNjcmlwdGlvbi5cbiAgICBpZiAodGhpcy5fYnVpbGRlckRlc2NyaXB0aW9uTWFwLmhhcyhidWlsZGVyQ29uZmlnLmJ1aWxkZXIpKSB7XG4gICAgICByZXR1cm4gb2YodGhpcy5fYnVpbGRlckRlc2NyaXB0aW9uTWFwLmdldChidWlsZGVyQ29uZmlnLmJ1aWxkZXIpIGFzIEJ1aWxkZXJEZXNjcmlwdGlvbik7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBPYnNlcnZhYmxlKChvYnMpID0+IHtcbiAgICAgIC8vIFRPRE86IHRoaXMgcHJvYmFibHkgbmVlZHMgdG8gYmUgbW9yZSBsaWtlIE5vZGVNb2R1bGVzRW5naW5lSG9zdC5cbiAgICAgIGNvbnN0IGJhc2VkaXIgPSBnZXRTeXN0ZW1QYXRoKHRoaXMuX3dvcmtzcGFjZS5yb290KTtcbiAgICAgIGNvbnN0IFtwa2csIGJ1aWxkZXJOYW1lXSA9IGJ1aWxkZXJDb25maWcuYnVpbGRlci5zcGxpdCgnOicpO1xuICAgICAgY29uc3QgcGtnSnNvblBhdGggPSBub2RlUmVzb2x2ZShwa2csIHsgYmFzZWRpciwgcmVzb2x2ZVBhY2thZ2VKc29uOiB0cnVlLCBjaGVja0xvY2FsOiB0cnVlIH0pO1xuICAgICAgbGV0IGJ1aWxkZXJzSnNvblBhdGg6IFBhdGg7XG4gICAgICBsZXQgYnVpbGRlclBhdGhzOiBCdWlsZGVyUGF0aHM7XG5cbiAgICAgIC8vIFJlYWQgdGhlIGBidWlsZGVyc2AgZW50cnkgb2YgcGFja2FnZS5qc29uLlxuICAgICAgcmV0dXJuIHRoaXMuX2xvYWRKc29uRmlsZShub3JtYWxpemUocGtnSnNvblBhdGgpKS5waXBlKFxuICAgICAgICBjb25jYXRNYXAoKHBrZ0pzb246IEpzb25PYmplY3QpID0+IHtcbiAgICAgICAgICBjb25zdCBwa2dKc29uQnVpbGRlcnNlbnRyeSA9IHBrZ0pzb25bJ2J1aWxkZXJzJ10gYXMgc3RyaW5nO1xuICAgICAgICAgIGlmICghcGtnSnNvbkJ1aWxkZXJzZW50cnkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aHJvd0Vycm9yKG5ldyBCdWlsZGVyQ2Fubm90QmVSZXNvbHZlZEV4Y2VwdGlvbihidWlsZGVyQ29uZmlnLmJ1aWxkZXIpKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBidWlsZGVyc0pzb25QYXRoID0gam9pbihkaXJuYW1lKG5vcm1hbGl6ZShwa2dKc29uUGF0aCkpLCBwa2dKc29uQnVpbGRlcnNlbnRyeSk7XG5cbiAgICAgICAgICByZXR1cm4gdGhpcy5fbG9hZEpzb25GaWxlKGJ1aWxkZXJzSnNvblBhdGgpO1xuICAgICAgICB9KSxcbiAgICAgICAgLy8gVmFsaWRhdGUgYnVpbGRlcnMganNvbi5cbiAgICAgICAgY29uY2F0TWFwKChidWlsZGVyUGF0aHNNYXApID0+IHRoaXMuX3dvcmtzcGFjZS52YWxpZGF0ZUFnYWluc3RTY2hlbWE8QnVpbGRlclBhdGhzTWFwPihcbiAgICAgICAgICBidWlsZGVyUGF0aHNNYXAsIHRoaXMuX2J1aWxkZXJzU2NoZW1hKSksXG4gICAgICAgIGNvbmNhdE1hcCgoYnVpbGRlclBhdGhzTWFwKSA9PiB7XG4gICAgICAgICAgYnVpbGRlclBhdGhzID0gYnVpbGRlclBhdGhzTWFwLmJ1aWxkZXJzW2J1aWxkZXJOYW1lXTtcblxuICAgICAgICAgIGlmICghYnVpbGRlclBhdGhzKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhyb3dFcnJvcihuZXcgQnVpbGRlckNhbm5vdEJlUmVzb2x2ZWRFeGNlcHRpb24oYnVpbGRlckNvbmZpZy5idWlsZGVyKSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gUmVzb2x2ZSBwYXRocyBpbiB0aGUgYnVpbGRlciBwYXRocy5cbiAgICAgICAgICBjb25zdCBidWlsZGVySnNvbkRpciA9IGRpcm5hbWUoYnVpbGRlcnNKc29uUGF0aCk7XG4gICAgICAgICAgYnVpbGRlclBhdGhzLnNjaGVtYSA9IGpvaW4oYnVpbGRlckpzb25EaXIsIGJ1aWxkZXJQYXRocy5zY2hlbWEpO1xuICAgICAgICAgIGJ1aWxkZXJQYXRocy5jbGFzcyA9IGpvaW4oYnVpbGRlckpzb25EaXIsIGJ1aWxkZXJQYXRocy5jbGFzcyk7XG5cbiAgICAgICAgICAvLyBTYXZlIHRoZSBidWlsZGVyIHBhdGhzIHNvIHRoYXQgd2UgY2FuIGxhemlseSBsb2FkIHRoZSBidWlsZGVyLlxuICAgICAgICAgIHRoaXMuX2J1aWxkZXJQYXRoc01hcC5zZXQoYnVpbGRlckNvbmZpZy5idWlsZGVyLCBidWlsZGVyUGF0aHMpO1xuXG4gICAgICAgICAgLy8gTG9hZCB0aGUgc2NoZW1hLlxuICAgICAgICAgIHJldHVybiB0aGlzLl9sb2FkSnNvbkZpbGUoYnVpbGRlclBhdGhzLnNjaGVtYSk7XG4gICAgICAgIH0pLFxuICAgICAgICBtYXAoYnVpbGRlclNjaGVtYSA9PiB7XG4gICAgICAgICAgY29uc3QgYnVpbGRlckRlc2NyaXB0aW9uID0ge1xuICAgICAgICAgICAgbmFtZTogYnVpbGRlckNvbmZpZy5idWlsZGVyLFxuICAgICAgICAgICAgc2NoZW1hOiBidWlsZGVyU2NoZW1hLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IGJ1aWxkZXJQYXRocy5kZXNjcmlwdGlvbixcbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgLy8gU2F2ZSB0byBjYWNoZSBiZWZvcmUgcmV0dXJuaW5nLlxuICAgICAgICAgIHRoaXMuX2J1aWxkZXJEZXNjcmlwdGlvbk1hcC5zZXQoYnVpbGRlckRlc2NyaXB0aW9uLm5hbWUsIGJ1aWxkZXJEZXNjcmlwdGlvbik7XG5cbiAgICAgICAgICByZXR1cm4gYnVpbGRlckRlc2NyaXB0aW9uO1xuICAgICAgICB9KSxcbiAgICAgICkuc3Vic2NyaWJlKG9icyk7XG4gICAgfSk7XG4gIH1cblxuICB2YWxpZGF0ZUJ1aWxkZXJPcHRpb25zPE9wdGlvbnNUPihcbiAgICBidWlsZGVyQ29uZmlnOiBCdWlsZGVyQ29uZmlndXJhdGlvbjxPcHRpb25zVD4sIGJ1aWxkZXJEZXNjcmlwdGlvbjogQnVpbGRlckRlc2NyaXB0aW9uLFxuICApOiBPYnNlcnZhYmxlPEJ1aWxkZXJDb25maWd1cmF0aW9uPE9wdGlvbnNUPj4ge1xuICAgIHJldHVybiB0aGlzLl93b3Jrc3BhY2UudmFsaWRhdGVBZ2FpbnN0U2NoZW1hPE9wdGlvbnNUPihcbiAgICAgIGJ1aWxkZXJDb25maWcub3B0aW9ucywgYnVpbGRlckRlc2NyaXB0aW9uLnNjaGVtYSxcbiAgICApLnBpcGUoXG4gICAgICBtYXAodmFsaWRhdGVkT3B0aW9ucyA9PiB7XG4gICAgICAgIGJ1aWxkZXJDb25maWcub3B0aW9ucyA9IHZhbGlkYXRlZE9wdGlvbnM7XG5cbiAgICAgICAgcmV0dXJuIGJ1aWxkZXJDb25maWc7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG5cbiAgZ2V0QnVpbGRlcjxPcHRpb25zVD4oXG4gICAgYnVpbGRlckRlc2NyaXB0aW9uOiBCdWlsZGVyRGVzY3JpcHRpb24sIGNvbnRleHQ6IEJ1aWxkZXJDb250ZXh0LFxuICApOiBCdWlsZGVyPE9wdGlvbnNUPiB7XG4gICAgY29uc3QgbmFtZSA9IGJ1aWxkZXJEZXNjcmlwdGlvbi5uYW1lO1xuICAgIGxldCBidWlsZGVyQ29uc3RydWN0b3I6IEJ1aWxkZXJDb25zdHJ1Y3RvcjxPcHRpb25zVD47XG5cbiAgICAvLyBDaGVjayBjYWNoZSBmb3IgdGhpcyBidWlsZGVyLlxuICAgIGlmICh0aGlzLl9idWlsZGVyQ29uc3RydWN0b3JNYXAuaGFzKG5hbWUpKSB7XG4gICAgICBidWlsZGVyQ29uc3RydWN0b3IgPSB0aGlzLl9idWlsZGVyQ29uc3RydWN0b3JNYXAuZ2V0KG5hbWUpIGFzIEJ1aWxkZXJDb25zdHJ1Y3RvcjxPcHRpb25zVD47XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmICghdGhpcy5fYnVpbGRlclBhdGhzTWFwLmhhcyhuYW1lKSkge1xuICAgICAgICB0aHJvdyBuZXcgQnVpbGRlck5vdEZvdW5kRXhjZXB0aW9uKG5hbWUpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBidWlsZGVyUGF0aHMgPSB0aGlzLl9idWlsZGVyUGF0aHNNYXAuZ2V0KG5hbWUpIGFzIEJ1aWxkZXJQYXRocztcblxuICAgICAgLy8gVE9ETzogc3VwcG9ydCBtb3JlIHRoYW4gdGhlIGRlZmF1bHQgZXhwb3J0LCBtYXliZSB2aWEgYnVpbGRlciNpbXBvcnQtbmFtZS5cbiAgICAgIGNvbnN0IGJ1aWxkZXJNb2R1bGUgPSByZXF1aXJlKGdldFN5c3RlbVBhdGgoYnVpbGRlclBhdGhzLmNsYXNzKSk7XG4gICAgICBidWlsZGVyQ29uc3RydWN0b3IgPSBidWlsZGVyTW9kdWxlWydkZWZhdWx0J10gYXMgQnVpbGRlckNvbnN0cnVjdG9yPE9wdGlvbnNUPjtcblxuICAgICAgLy8gU2F2ZSBidWlsZGVyIHRvIGNhY2hlIGJlZm9yZSByZXR1cm5pbmcuXG4gICAgICB0aGlzLl9idWlsZGVyQ29uc3RydWN0b3JNYXAuc2V0KGJ1aWxkZXJEZXNjcmlwdGlvbi5uYW1lLCBidWlsZGVyQ29uc3RydWN0b3IpO1xuICAgIH1cblxuICAgIGNvbnN0IGJ1aWxkZXIgPSBuZXcgYnVpbGRlckNvbnN0cnVjdG9yKGNvbnRleHQpO1xuXG4gICAgcmV0dXJuIGJ1aWxkZXI7XG4gIH1cblxuICBwcml2YXRlIF9sb2FkSnNvbkZpbGUocGF0aDogUGF0aCk6IE9ic2VydmFibGU8SnNvbk9iamVjdD4ge1xuICAgIHJldHVybiB0aGlzLl93b3Jrc3BhY2UuaG9zdC5yZWFkKG5vcm1hbGl6ZShwYXRoKSkucGlwZShcbiAgICAgIG1hcChidWZmZXIgPT4gdmlydHVhbEZzLmZpbGVCdWZmZXJUb1N0cmluZyhidWZmZXIpKSxcbiAgICAgIG1hcChzdHIgPT4gcGFyc2VKc29uKHN0ciwgSnNvblBhcnNlTW9kZS5Mb29zZSkgYXMge30gYXMgSnNvbk9iamVjdCksXG4gICAgKTtcbiAgfVxufVxuIl19