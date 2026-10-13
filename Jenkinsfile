// CodexDesk: every master change builds the Release installer and publishes it to the router app catalog.

if (env.BRANCH_NAME && env.BRANCH_NAME != 'master') {
    currentBuild.result = 'ABORTED'
    currentBuild.description = 'Skipped: only master is published'
    echo currentBuild.description
    return
}

pipeline {
    agent {
        kubernetes {
            cloud 'hq.encycam.com'
            inheritFrom 'win-root-lts2022'
            defaultContainer 'jnlp'
            yamlMergeStrategy merge()
            yaml '''
apiVersion: v1
kind: Pod
spec:
  nodeSelector:
    kubernetes.io/os: windows
    kubernetes.io/arch: amd64
  containers:
    - name: builder
      image: nexus.hq.encycam.com/st/dotnet/sdk/vcredist:vc17-sdk10.0.301-windowsservercore-ltsc2022
      imagePullPolicy: IfNotPresent
      command: ['powershell']
      args: ['Start-Sleep', '999999']
      resources:
        requests:
          cpu: '2'
          memory: 4Gi
        limits:
          cpu: '4'
          memory: 8Gi
'''
        }
    }

    options {
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 60, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '30'))
        skipDefaultCheckout(true)
    }

    environment {
        GERRIT_URL = 'https://gerrit1.hq.encycam.com/a/CodexDesk'
        GERRIT_CREDENTIAL_ID = 'jenkins4gerrit_gerrit1'
        BRANCH = 'master'
        NODE_VERSION = '22.14.0'
        // Named router key with the apps:publish right, owned by the catalog entry owner.
        PORTAL_KEY_CREDENTIAL_ID = 'codexdesk-portal-key'
        PORTAL_APP_CATALOG = 'https://coder-portal.encycam.com/api/apps/codex-desk'
    }

    stages {
        stage('Checkout master') {
            steps {
                checkout(poll: false, scm: [
                    $class: 'GitSCM',
                    branches: [[name: "refs/heads/${env.BRANCH}"]],
                    extensions: [
                        [$class: 'CloneOption', shallow: true, depth: 1, noTags: true,
                            reference: '', timeout: 10, honorRefspec: true]
                    ],
                    userRemoteConfigs: [[
                        url: env.GERRIT_URL,
                        credentialsId: env.GERRIT_CREDENTIAL_ID,
                        refspec: "+refs/heads/${env.BRANCH}:refs/remotes/origin/${env.BRANCH}"
                    ]]
                ])
            }
        }

        stage('Prepare Node.js') {
            steps {
                container('builder') {
                    powershell '''
                        $ErrorActionPreference = 'Stop'
                        $nodeDirectory = Join-Path $env:WORKSPACE '.local/node'
                        New-Item -ItemType Directory -Path $nodeDirectory -Force | Out-Null
                        $nodeArchive = Join-Path $nodeDirectory 'node.zip'
                        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$env:NODE_VERSION/node-v$env:NODE_VERSION-win-x64.zip" -OutFile $nodeArchive
                        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeDirectory -Force
                    '''
                }
            }
        }

        stage('Build Release installer') {
            steps {
                container('builder') {
                    withEnv(["PATH+NODE=${env.WORKSPACE}/.local/node/node-v${env.NODE_VERSION}-win-x64"]) {
                        bat 'call npm.cmd ci'
                        bat 'call npm.cmd run package'
                        bat 'call npm.cmd run release:candidate'
                        bat 'call npm.cmd run release:promote -- --prepared-candidate'
                        bat 'call npm.cmd run release:installer'
                    }
                }
                archiveArtifacts artifacts: 'release/installer/*', fingerprint: true
            }
        }

        stage('Publish to router portal') {
            steps {
                container('builder') {
                    withCredentials([string(credentialsId: env.PORTAL_KEY_CREDENTIAL_ID, variable: 'PORTAL_KEY')]) {
                        script {
                            def published = powershell(returnStdout: true, script: '''
                                $ErrorActionPreference = 'Stop'
                                $ProgressPreference = 'SilentlyContinue'
                                $info = Get-Content -Raw -LiteralPath 'release/installer/release-info.json' | ConvertFrom-Json
                                $version = "$($info.version).$env:BUILD_NUMBER"
                                $headers = @{ Authorization = "Bearer $env:PORTAL_KEY"; 'X-Requested-With' = 'cli' }
                                $card = Invoke-RestMethod -Uri $env:PORTAL_APP_CATALOG -Headers $headers

                                # The owner quota holds a single installer, so the previous one goes first.
                                foreach ($old in @($card.versions)) {
                                    Invoke-RestMethod -Method Delete -Uri "$env:PORTAL_APP_CATALOG/versions/$($old.version)" -Headers $headers | Out-Null
                                    Write-Host "Removed $($old.version)"
                                }
                                $query = "version=$([uri]::EscapeDataString($version))&filename=$([uri]::EscapeDataString($info.installer))"
                                $reply = Invoke-RestMethod -Method Post -Uri "$env:PORTAL_APP_CATALOG/versions?$query" -Headers $headers `
                                    -ContentType 'application/octet-stream' -InFile (Join-Path 'release/installer' $info.installer)
                                if ($reply.sha256 -ne $info.sha256) { throw "Portal stored $($reply.sha256), built $($info.sha256)" }
                                Write-Host "SHA-256 $($reply.sha256)"
                                Write-Output $version
                            ''').trim()
                            currentBuild.description = "Published ${published} to the router app catalog"
                        }
                    }
                }
            }
        }
    }
}
