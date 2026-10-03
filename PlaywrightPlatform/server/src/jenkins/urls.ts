// Addresses of Jenkins pages. Pure functions, so a link can be built without calling Jenkins.

export function jenkinsJobUrl(baseUrl: string, job: string): string {
  return `${baseUrl}/job/${encodeURIComponent(job)}/`;
}

export function jenkinsBuildUrl(baseUrl: string, job: string, buildNumber: number): string {
  return `${jenkinsJobUrl(baseUrl, job)}${buildNumber}/`;
}

/** Where the Playwright report archived by the pipeline opens. */
export function jenkinsReportUrl(baseUrl: string, job: string, buildNumber: number): string {
  return `${jenkinsBuildUrl(baseUrl, job, buildNumber)}artifact/playwright-report/index.html`;
}
