#!/usr/bin/env bun

interface LockfilePackage {
	0: string
	1: string
	2: {
		dependencies?: Record<string, string>
		devDependencies?: Record<string, string>
		peerDependencies?: Record<string, string>
		optionalDependencies?: Record<string, string>
		bin?: string | Record<string, string>
		os?: string | string[]
		cpu?: string | string[]
	}
	3: string
}

interface Lockfile {
	lockfileVersion: number
	workspaces?: {
		[key: string]: {
			name: string
			dependencies: Record<string, string>
			devDependencies?: Record<string, string>
		}
	}
	packages: Record<string, LockfilePackage>
}

const findRootDir = async (): Promise<string> => {
	let currentDir = process.cwd()
	
	while (true) {
		try {
			const packageJsonPath = `${currentDir}/package.json`
			const packageJson = JSON.parse(
				await Bun.file(packageJsonPath).text()
			)
			// Return the directory if it has a package.json, regardless of workspaces
			return currentDir
		} catch (err: any) {
			if (currentDir === "/" || currentDir === "") {
				throw new Error("Could not find package.json")
			}
			
			const parentDir = currentDir.split("/").slice(0, -1).join("/")
			if (parentDir === currentDir) {
				throw new Error("Could not find package.json")
			}
			currentDir = parentDir
		}
	}
}

const readLockfile = async (): Promise<Lockfile> => {
	try {
		const rootDir = await findRootDir()
		const content = await Bun.file(`${rootDir}/bun.lock`).text()

		const cleanContent = content.replace(/,(\s*[}\]])/g, "$1")
		return JSON.parse(cleanContent)
	} catch (error) {
		console.error("Error reading bun.lock:", error)
		process.exit(1)
	}
}

const findDependencySource = (
	lockfile: Lockfile,
	targetDep: string
): { workspace: string; type: "prod" | "dev" }[] => {
	const sources: { workspace: string; type: "prod" | "dev" }[] = []
	const workspaces = lockfile.workspaces || { "": { name: "", dependencies: {}, devDependencies: {} } }
	
	for (const [wsPath, workspace] of Object.entries(workspaces)) {
		if (workspace.dependencies && targetDep in workspace.dependencies) {
			sources.push({ workspace: workspace.name || wsPath, type: "prod" })
		}
		if (workspace.devDependencies && targetDep in workspace.devDependencies) {
			sources.push({ workspace: workspace.name || wsPath, type: "dev" })
		}
	}
	return sources
}

const findTransitiveDependencies = (
	lockfile: Lockfile,
	pkgName: string,
	visited = new Set<string>()
): { name: string; version: string; through: string[] }[] => {
	const results: { name: string; version: string; through: string[] }[] = []
	if (visited.has(pkgName)) return results
	visited.add(pkgName)
	for (const [name, pkg] of Object.entries(lockfile.packages)) {
		if (!pkg || !Array.isArray(pkg) || pkg.length < 3) continue
		const deps = pkg[2]?.dependencies || {}
		if (deps[pkgName]) {
			const version = pkg[0].split("@").pop() || "unknown"
			results.push({
				name,
				version,
				through: []
			})
			const transitive = findTransitiveDependencies(lockfile, name, visited)
			for (const dep of transitive) {
				dep.through = [name, ...dep.through]
				results.push(dep)
			}
		}
	}
	return results
}

const getCurrentPackageName = async () => {
	try {
		const rootDir = await findRootDir()
		const currentDir = process.cwd()
		const packageJson = JSON.parse(await Bun.file("package.json").text())
		if (currentDir === rootDir) {
			return ""
		}
		return packageJson.name || null
	} catch {
		return null
	}
}

const listDependencies = async (lockfile: Lockfile, recursive = false) => {
	const currentPackage = await getCurrentPackageName()
	const workspaces = lockfile.workspaces || { "": { name: "", dependencies: {}, devDependencies: {} } }
	
	for (const [wsPath, workspace] of Object.entries(workspaces)) {
		if (
			!recursive &&
			!(currentPackage === ""
				? wsPath === ""
				: workspace.name === currentPackage)
		) {
			continue
		}
		console.log(`\n📦 ${workspace.name || wsPath}:`)
		if (workspace.dependencies) {
			console.log("\nProduction Dependencies:")
			for (const [dep, version] of Object.entries(workspace.dependencies)) {
				console.log(`  ${dep}@${version}`)
			}
		}
		if (workspace.devDependencies) {
			console.log("\nDevelopment Dependencies:")
			for (const [dep, version] of Object.entries(workspace.devDependencies)) {
				console.log(`  ${dep}@${version}`)
			}
		}
	}
}

const whyDependency = async (lockfile: Lockfile, targetDep: string) => {
	const directSources = findDependencySource(lockfile, targetDep)
	const transitiveSources = findTransitiveDependencies(lockfile, targetDep)
	if (directSources.length === 0 && transitiveSources.length === 0) {
		console.log(`❌ Package "${targetDep}" not found in any workspace`)
		return
	}
	console.log(`📦 Package "${targetDep}" is required by:`)
	if (directSources.length > 0) {
		console.log("\nDirect Dependencies:")
		for (const source of directSources) {
			console.log(
				`  • ${source.workspace} (${source.type === "prod" ? "production" : "development"})`
			)
		}
	}
	if (transitiveSources.length > 0) {
		console.log("\nTransitive Dependencies:")
		for (const source of transitiveSources) {
			const path = source.through.length
				? ` (via ${source.through.join(" → ")})`
				: ""
			console.log(`  • ${source.name}@${source.version}${path}`)
		}
	}
}

interface AuditNode {
	version: string
	dependencies?: Record<string, AuditNode>
	dev?: boolean
}

interface AuditTree {
	name: string
	version: string
	requires: Record<string, string>
	dependencies: Record<string, AuditNode>
}

const lockfileToAuditTree = (lockfile: Lockfile): AuditTree => {
	const workspaces = lockfile.workspaces || { "": { name: "", dependencies: {}, devDependencies: {} } }
	const rootWorkspace = workspaces[""] || Object.values(workspaces)[0]
	
	const requires: Record<string, string> = {}
	const dependencies: Record<string, AuditNode> = {}

	// Add all dependencies from package.json
	if (rootWorkspace.dependencies) {
		for (const [name, version] of Object.entries(rootWorkspace.dependencies)) {
			requires[name] = version
			dependencies[name] = { version }
		}
	}

	if (rootWorkspace.devDependencies) {
		for (const [name, version] of Object.entries(rootWorkspace.devDependencies)) {
			requires[name] = version
			dependencies[name] = { version, dev: true }
		}
	}

	// Add all packages from lockfile with their exact versions
	for (const [fullName, pkg] of Object.entries(lockfile.packages)) {
		if (!pkg || !Array.isArray(pkg) || pkg.length < 3) continue
		
		// Extract the actual package name and version
		const [pkgName] = fullName.split('@')
		if (!pkgName) continue
		
		const version = pkg[0].split('@').pop() || 'unknown'
		
		if (!dependencies[pkgName]) {
			dependencies[pkgName] = { version }
		}

		// Add dependencies of this package
		const meta = pkg[2]
		if (meta.dependencies) {
			if (!dependencies[pkgName].dependencies) {
				dependencies[pkgName].dependencies = {}
			}
			for (const [depName, depVersion] of Object.entries(meta.dependencies)) {
				if (dependencies[pkgName].dependencies) {
					dependencies[pkgName].dependencies[depName] = {
						version: typeof depVersion === 'string' ? depVersion : '*'
					}
				}
			}
		}
	}

	return {
		name: rootWorkspace.name || "root",
		version: "1.0.0",
		requires,
		dependencies
	}
}

interface Advisory {
	id: number
	title: string
	url: string
	severity: "info" | "low" | "moderate" | "high" | "critical"
	vulnerable_versions: string
	patched_versions: string
}

const auditDependencies = async () => {
	try {
		const lockfile = await readLockfile()
		const auditTree = lockfileToAuditTree(lockfile)
		const registry = "https://registry.npmjs.org"
		const auditUrl = `${registry}/-/npm/v1/security/audits`
		const res = await fetch(auditUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json",
				"npm-command": "audit",
				"npm-version": "10.2.4",
				"user-agent": "npm/10.2.4 node/v20.9.0 darwin arm64 workspaces/false"
			},
			body: JSON.stringify({
				...auditTree,
				install: [],
				remove: [],
				metadata: {
					"node_version": "v20.9.0",
					"npm_version": "10.2.4",
					"platform": "darwin",
					"arch": "arm64"
				}
			})
		})
		if (res.status === 404) {
			console.error("The npm audit endpoint is not available")
			process.exit(1)
		}
		if (res.status !== 200) {
			console.error(
				`Audit request failed with status ${res.status}:`,
				await res.text()
			)
			process.exit(1)
		}
		const report = (await res.json()) as {
			advisories: Record<string, Advisory>
			metadata: {
				vulnerabilities: {
					info: number
					low: number
					moderate: number
					high: number
					critical: number
				}
			}
		}

		const vulns = report.metadata.vulnerabilities
		const total =
			vulns.info + vulns.low + vulns.moderate + vulns.high + vulns.critical
		if (total === 0) {
			console.log("✅ No known vulnerabilities found")
			return
		}
		console.log("\n🔍 Found vulnerabilities:")
		if (vulns.critical > 0) console.log(`  ❗ Critical: ${vulns.critical}`)
		if (vulns.high > 0) console.log(`  ⚠️  High: ${vulns.high}`)
		if (vulns.moderate > 0) console.log(`  ⚠️  Moderate: ${vulns.moderate}`)
		if (vulns.low > 0) console.log(`  ℹ️  Low: ${vulns.low}`)
		if (vulns.info > 0) console.log(`  ℹ️  Info: ${vulns.info}`)
		console.log("\nDetails:")
		for (const advisory of Object.values(report.advisories)) {
			console.log(`\n${getSeverityIcon(advisory.severity)} ${advisory.title}`)
			console.log(`   Severity: ${advisory.severity}`)
			console.log(`   Vulnerable versions: ${advisory.vulnerable_versions}`)
			console.log(`   Patched versions: ${advisory.patched_versions}`)
			console.log(`   More info: ${advisory.url}`)
		}
	} catch (error) {
		console.error("Error running audit:", error)
		process.exit(1)
	}
}

const getSeverityIcon = (severity: string): string => {
	switch (severity) {
		case "critical":
			return "❗"
		case "high":
			return "⚠️"
		case "moderate":
			return "⚠️"
		case "low":
			return "ℹ️"
		case "info":
			return "ℹ️"
		default:
			return "•"
	}
}

const main = async () => {
	const args = process.argv.slice(2)
	const command = args[0]
	const isRecursive = args.includes("-r")
	const targetArg = command === "why" ? args[1] : undefined

	if (command === "list" && isRecursive) {
		args.splice(args.indexOf("-r"), 1)
	}

	if (!command) {
		console.log(`
Usage: bunx bun-deps <command> [options]
Commands:
  list [-r]    List dependencies in the current package (use -r for all workspaces)
  why <pkg>    Show why a package is installed
  audit        Check for known vulnerabilities
		`)
		process.exit(1)
	}

	const lockfile = await readLockfile()

	switch (command) {
		case "list":
			await listDependencies(lockfile, isRecursive)
			break
		case "why":
			if (!targetArg) {
				console.error("Please specify a package name")
				process.exit(1)
			}
			await whyDependency(lockfile, targetArg)
			break
		case "audit":
			await auditDependencies()
			break
		default:
			console.error("Unknown command:", command)
			process.exit(1)
	}
}

main().catch(console.error)
