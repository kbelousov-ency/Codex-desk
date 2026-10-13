// CodexDesk: Windows installer build and publication to the router app catalog.
// Builds Nightly; router upload will be filled in later.

if ((env.BRANCH_NAME && env.BRANCH_NAME != 'master') ||
    currentBuild.getBuildCauses('hudson.model.Cause$UserIdCause').isEmpty()) {
    currentBuild.result = 'ABORTED'
    currentBuild.description = 'Skipped: manual build of master is required'
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
        PORTAL_KEY_CREDENTIAL_ID = 'codexdesk-portal-key'
        // Fill in the router catalog endpoint when implementing upload.
        PORTAL_APP_CATALOG = ''
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

        stage('Build Nightly installer') {
            steps {
                container('builder') {
                    withEnv(["PATH+NODE=${env.WORKSPACE}/.local/node/node-v${env.NODE_VERSION}-win-x64"]) {
                        bat 'call npm.cmd ci'
                        bat 'call npm.cmd run package'
                        bat 'call npm.cmd run package:installer'
                    }
                }
                archiveArtifacts artifacts: 'artifacts/installer-nightly/*', fingerprint: true
                script {
                    currentBuild.description = 'Nightly installer built; router publication is not implemented'
                }
            }
        }

        stage('Publish to router portal (TODO)') {
            steps {
                echo 'TODO: bind PORTAL_KEY_CREDENTIAL_ID and upload to PORTAL_APP_CATALOG.'
            }
        }
    }
}
