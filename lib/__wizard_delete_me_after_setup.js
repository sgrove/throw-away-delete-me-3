import Container from '../components/container'
import MoreStories from '../components/more-stories'
import HeroPost from '../components/hero-post'
import Intro from '../components/intro'
import Alert from '../components/alert'
import Footer from '../components/footer'
import Meta from '../components/meta'
import Head from 'next/head'
import {
  ONE_GRAPH_APP_ID,
  AUTO_DETECTED_GITHUB_LINK,
  GIT_CHECKOUT_LINK,
  FEEDBACK_REPO_ID,
  ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN,
} from '../lib/constants'
import {
  auth,
  destroyAuth,
  saveAuth,
  useAuthGuardian,
  useFetchSupportedServices,
  fetchOneGraph,
} from '../lib/oneGraphNextClient'
import { isSsr } from './common'
import { corsPrompt } from '../lib/metaHelpers'
import MultiStep from 'react-multistep'
import OneGraphAuth from 'onegraph-auth'
import { SubscriptionClient } from 'onegraph-subscription-client'

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

const vercelOperationDoc = `
query FindMeOnVercel {
  me {
    vercel: zeit {
      id
      email
      name
      username
      avatar
    }
  }
}

query VercelProjectByNameQuery($projectName: String!) {
  vercel: zeit {
    secrets {
      uid
      name
      created
    }
    projectByName(name: $projectName) {
      ...ZeitProjectFullFragment
    }
  }
}

query VercelProjectByIdQuery($projectId: String!) {
  vercel: zeit {
    secrets {
      uid
      name
      created
    }
    projectById(id: $projectId) {
      ...ZeitProjectFullFragment
    }
  }
}

mutation TriggerRedeployMutation(
  $projectId: String!
) {
  vercel: zeit {
    triggerProjectRedeployment(
      input: { projectId: $projectId }
    ) {
      project {
        ...ZeitProjectFullFragment
      }
    }
  }
}

mutation CreateSecretMutation(
  $name: String!
  $value: String!
) {
  vercel: zeit {
    createSecret(input: { name: $name, value: $value }) {
      secret {
        created
        name
        uid
      }
    }
  }
}

mutation SetEnvironmentalVariableMutation(
  $projectId: String!
  $key: String!
  $secretId: String!
) {
  vercel: zeit {
    createEnvironmentalVariable(
      input: {
        projectId: $projectId
        key: $key
        secretId: $secretId
      }
    ) {
      environmentalVariable {
        configurationId
        createdAt
        key
        target
        updatedAt
        value
      }
    }
  }
}

subscription DeploymentCreatedSubscription(
  $projectId: String!
) {
  vercel: zeit {
    deploymentCreatedEvent(
      input: { projectId: $projectId }
    ) {
      raw
    }
  }
}

subscription DeploymentReadySubscription(
  $projectId: String!
) {
  vercel: zeit {
    deploymentReadyEvent(input: { projectId: $projectId }) {
      raw
    }
  }
}

subscription LogSubscription($projectId: String!) {
  vercel: zeit {
    logEvent(input: { projectId: $projectId }) {
      raw
    }
  }
}

fragment ZeitProjectFullFragment on ZeitProjectFull {
  id
  name
  updatedAt
  createdAt
  accountId
  alias {
    uid
    alias
    created
    createdAt
    updatedAt
    deploymentId
    projectId
  }
  latestDeployments {
    uid
    url
  }
  env {
    configurationId
    createdAt
    key
    target
    updatedAt
    value
  }
}`

/** Our first-setup wizard has to do the following steps:
0. Display the inferred project name
1. Try to get the project id based on name
2. Check to see if ONE_GRAPH_APP_ID is set via ENV. If not, check in the project env list via api (in case the user refreshed the page before redeploying)
2a. Handle CORS prompt here so we can make our calls
3. If it's not set in env or the API, render a link asking them to go to their OG dashboard and copy/paste it in (with example picture) [SERVER=DONE]
4. Create a secret for ONE_GRAPH_APP_ID
5. Set the env var 
6. Repeat 2-5 for SERVER_SIDE_AUTH_TOKEN env var for GitHub access
7. Once all the env vars are set, create a deploy hook url 
8. Hit the deploy-hook url from the browser
9. Show progress bar for new deploy
10. Refresh the page once the deploy is done, app will now be configured and run like normal
*/

// Vercel doesn't give us the project name or id as a build variable, so we have to try to infer it based on the url for the first deploy
const guessVercelProjectName = (windowLocationHostname) => {
  if (isSsr) {
    return null
  }
  const pieces = windowLocationHostname.match(
    '^([a-zA-Z0-9-]+).[a-zA-Z0-9-_]*?.?now.sh'
  )
  console.log('Pieces:', pieces)
  return (pieces || [])[1]
}
const uuidV4Regex = new RegExp(
  /^[A-F\d]{8}-[A-F\d]{4}-4[A-F\d]{3}-[89AB][A-F\d]{3}-[A-F\d]{12}$/i
)

const isValidUUID = (string) => {
  return uuidV4Regex.test(string)
}

// const oneGraphSiteHost = 'https://www.onegraph.com'
const oneGraphSiteHost = 'http://localhost:3001'

const StepSetOneGraphAppId = ({ oneGraphAppId, setOneGraphAppId }) => {
  const errorMessage = isValidUUID(oneGraphAppId)
    ? null
    : 'OneGraph appId should be a valid UUID.'

  return (
    <>
      <p className="card">
        <label>
          First, enter your OneGraph <code>appId</code> here:
          <input
            type="text"
            className="card"
            placeholder="OneGraph appId"
            defaultValue={oneGraphAppId || ''}
            onChange={(event) => {
              const value = event.target.value
              setOneGraphAppId(value)
            }}
          />
        </label>
      </p>
      You can get one to copy/paste from the{' '}
      <a target="_blank" href={`${oneGraphSiteHost}/dashboard`}>
        OneGraph app dashboard
      </a>
      .
      <img src="/images/onegraph_app_id_preview.png" />
      <br />
    </>
  )
}

const StepSetCorsOrigin = ({
  oneGraphAppId,
  inferredVercelProjectName,
  onCorsConfiguredSuccess,
  oneGraphAuth,
}) => {
  return (
    <CorsCheck
      oneGraphAppId={oneGraphAppId}
      inferredVercelProjectName={inferredVercelProjectName}
      onCorsConfiguredSuccess={onCorsConfiguredSuccess}
      oneGraphAuth={oneGraphAuth}
    />
  )
}

const StepSetServerSideAuthToken = ({
  oneGraphAppId,
  oneGraphServerSideAccessToken,
  setOneGraphServerSideAccessToken,
}) => {
  if (!isValidUUID(oneGraphAppId)) {
    return 'Please set a valid app id in step 1 first'
  }

  return (
    <div>
      {' '}
      <h1>Server-side authentication token</h1>
      <p className="card">
        Next, we'll set up a server-side auth token to talk to GitHub from the{' '}
        <code>next.js</code> server.
        <br /> You can make a server-side auth token on{' '}
        <a
          target="_blank"
          href={`${oneGraphSiteHost}/dashboard/app/${oneGraphAppId}/auth/server-side`}
        >
          your OneGraph dashboard here
        </a>
        .<br />
        <label>
          <input
            type="text"
            className="card"
            placeholder="Server-side access token"
            defaultValue={oneGraphServerSideAccessToken || ''}
            onChange={(event) => {
              const value = event.target.value
              setOneGraphServerSideAccessToken(value)
            }}
          />
        </label>
      </p>
      <img src="/images/onegraph_server_side_auth_token_preview.png" />
    </div>
  )
}

const StepTriggerDeploy = ({
  vercelUser,
  onLoggedIntoVercel,
  oneGraphAuth,
  vercelProjectId,
  inferredVercelProjectName,
  oneGraphSubscriptClient,
  oneGraphServerSideAccessToken,
}) => {
  const [state, setState] = React.useState({
    vercelProject: null,
    secrets: [],
    actionName: null,
    projectLogs: '',
  })

  const addLogLines = (lines) => {
    setState((oldState) => {
      return {
        ...oldState,
        projectLogs: lines + '\n' + oldState.projectLogs,
      }
    })
  }

  const appIdIsSet = oneGraphAuth && oneGraphAuth.appId

  const refreshProject = async () => {
    if (!appIdIsSet) {
      return
    }

    const result = await fetchOneGraph(
      oneGraphAuth,
      vercelOperationDoc,
      { projectId: vercelProjectId },
      'VercelProjectByIdQuery'
    )
    const secrets = result?.data?.vercel?.secrets
    const vercelProject = result?.data?.vercel?.projectById

    setState((oldState) => {
      return { ...oldState, vercelProject: vercelProject, secrets: secrets }
    })

    return { vercelProject: vercelProject, secrets: secrets }
  }

  React.useEffect(() => {
    refreshProject()
  }, [vercelProjectId, oneGraphAuth && oneGraphAuth.appId])

  const setAppIdPrompt = 'Please set a valid app id in step 1 first'

  const loginPrompt = (
    <>
      As the last step, log into Vercel so we can set the environmental
      variables and trigger a new deploy.
      <br />
      <button
        onClick={async () => {
          console.log('PreAuth: ', oneGraphAuth, oneGraphAuth.accessToken())

          await oneGraphAuth.login('zeit')
          console.log('Done!')
          const isLoggedIn = await oneGraphAuth.isLoggedIn('zeit')
          console.log('Is logged in? ', isLoggedIn)
          if (isLoggedIn) {
            saveAuth(auth)
            onLoggedIntoVercel()
          }
        }}
      >
        Log in
      </button>
    </>
  )

  const fullSecretName = (envVarName) => {
    return `${(inferredVercelProjectName || '')
      .toLocaleLowerCase()
      .replace(/\W+/g, '_')}.${envVarName
      .toLocaleLowerCase()
      .replace(/\W+/g, '_')}`
  }

  const findSecretByName = (secrets, envVarName) => {
    const secretName = fullSecretName(envVarName)
    window.sstate = state
    return secrets.find((secret) => secret.name == secretName)
  }

  const findEnvVarByName = (project, envVarName) => {
    return (project.env || []).find((env) => env.key == envVarName)
  }

  const actions = !!state.vercelProject
    ? [
        {
          name: 'Create secrets',
          execute: async (state) => {
            console.log('Creating secret: ', 'ONE_GRAPH_APP_ID')
            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              {
                name: fullSecretName('ONE_GRAPH_APP_ID'),
                value: oneGraphAuth.appId,
              },
              'CreateSecretMutation'
            )

            console.log(
              'Creating secret: ',
              'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'
            )
            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              {
                name: fullSecretName('ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'),
                value: oneGraphServerSideAccessToken,
              },
              'CreateSecretMutation'
            )

            console.log('Refreshing project...')
          },
          finishedP: (state) => {
            return (
              !!findSecretByName(state.secrets, 'ONE_GRAPH_APP_ID') &&
              !!findSecretByName(
                state.secrets,
                'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'
              )
            )
          },
        },
        {
          name: 'Create environmental variables',
          execute: async (state) => {
            let secret = findSecretByName(state.secrets, 'ONE_GRAPH_APP_ID')
            console.log('Secret 1: ', secret)

            let secretId = secret.uid
            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              {
                projectId: state.vercelProject.id,
                key: 'ONE_GRAPH_APP_ID',
                secretId: secretId,
              },
              'SetEnvironmentalVariableMutation'
            )

            secret = findSecretByName(
              state.secrets,
              'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'
            )
            console.log('Secret 2: ', secret)

            secretId = secret.uid

            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              {
                projectId: state.vercelProject.id,
                key: 'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN',
                secretId: secretId,
              },
              'SetEnvironmentalVariableMutation'
            )
          },
          finishedP: () => {
            return (
              !!findEnvVarByName(state.vercelProject, 'ONE_GRAPH_APP_ID') &&
              !!findEnvVarByName(
                state.vercelProject,
                'ONE_GRAPH_SERVER_SIDE_ACCESS_TOKEN'
              )
            )
          },
        },
        {
          name: 'Trigger redeploy',
          execute: async (state) => {
            oneGraphSubscriptClient
              .request({
                query: vercelOperationDoc,
                variables: { projectId: state.vercelProject.id },
                operationName: 'DeploymentCreatedSubscription',
              })
              .subscribe(
                (next) => {
                  const deploymentId =
                    next.data?.vercel?.deploymentCreatedEvent?.raw?.payload
                      ?.deployment?.id
                  const ownerId =
                    next.data?.vercel?.deploymentCreatedEvent?.raw?.ownerId
                  const region =
                    next.data?.vercel?.deploymentCreatedEvent?.raw?.region

                  const logLine = `Deploy ${deploymentId} started for owner ${ownerId} to region "${region}"`

                  addLogLines(logLine)
                },
                (error) => console.error(error),
                () => console.log('done')
              )

            oneGraphSubscriptClient
              .request({
                query: vercelOperationDoc,
                variables: { projectId: state.vercelProject.id },
                operationName: 'DeploymentReadySubscription',
              })
              .subscribe(
                (next) => {
                  const deploymentId =
                    next.data?.vercel?.deploymentReadyEvent?.raw?.payload
                      ?.deployment?.id

                  const logLine = `Deploy ${deploymentId} finished - refresh to enter the AuthGuardian starterkit!"`
                  addLogLines(logLine)
                  const start = Date.now()
                  setInterval(() => {
                    const elapsed = Date.now() - start
                    const remaining = 5000 - elapsed
                    setState((oldState) => {
                      return {
                        ...oldState,
                        timeUntilReload: Math.floor(remaining),
                      }
                    })
                    if (remaining < 0) {
                      window.location.reload()
                    }
                  }, 100)
                },
                (error) => console.error(error),
                () => console.log('done')
              )

            oneGraphSubscriptClient
              .request({
                query: vercelOperationDoc,
                variables: { projectId: state.vercelProject.id },
                operationName: 'LogSubscription',
              })
              .subscribe(
                (next) => {
                  const logStatements = next.data?.vercel?.logEvent?.raw || []
                  let relevantLogs = logStatements
                    .filter((statement) => {
                      return (
                        statement.projectId === state.vercelProject.id &&
                        ['stdout'].indexOf(statement.type) > -1
                      )
                    })
                    .map((statement) => statement.message)
                    .reverse()
                    .join('\n')

                  addLogLines(relevantLogs)
                },
                (error) => console.error(error),
                () => console.log('done')
              )

            await fetchOneGraph(
              oneGraphAuth,
              vercelOperationDoc,
              { projectId: state.vercelProject.id },
              'TriggerRedeployMutation'
            )

            setState((oldState) => {
              return {
                ...oldState,
                projectLogs: 'Triggered redeploy, waiting for logs...',
              }
            })

            await refreshProject(state.vercelProject)
          },
          finishedP: (state) => {
            return false
          },
        },
      ]
    : null

  const commitPrompt = !!actions && (
    <>
      You're logged in and ready to go!
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => {
            const isExecuting = state.actionName === action.name
            return (
              <tr key={action.name}>
                <td className={isExecuting ? 'animate-flicker' : ''}>
                  {isExecuting ? '◌' : action.finishedP(state) ? '⚫' : '◯'}
                </td>
                <td>{action.name}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <button
        onClick={async () => {
          await asyncForEach(actions, async (action) => {
            console.log('Execute action: ', action)
            setState((oldState) => {
              return { ...oldState, actionName: action.name }
            })
            const actionState = await refreshProject()
            console.log('Project for ', action.name, actionState)
            await action.execute(actionState)
          })
          console.log('Done')
        }}
        disabled={!!state.actionName}
      >
        Make it so
      </button>
    </>
  )
  return (
    <div>
      {!appIdIsSet ? setAppIdPrompt : !vercelUser ? loginPrompt : commitPrompt}
      <br />
      {state.actionName === 'Trigger redeploy' ? (
        <div>
          <h1>
            {' '}
            > <code>Logs</code>{' '}
            {state.timeUntilReload
              ? `(refreshing automatically in ${(
                  state.timeUntilReload / 1000
                ).toFixed(2)} seconds...)`
              : null}
          </h1>
          <textarea
            className="card"
            style={{ userSelect: 'all' }}
            rows={10}
            value={state.projectLogs}
            readOnly={true}
          ></textarea>
        </div>
      ) : null}
    </div>
  )
}

function CorsCheck({
  oneGraphAppId,
  inferredVercelProjectName,
  onCorsConfiguredSuccess,
  oneGraphAuth,
}) {
  if (isSsr) {
    return 'Loading...'
  }

  const {
    missingOneGraphAppId,
    corsConfigurationRequired,
    loading,
    supportedServices,
  } = useFetchSupportedServices(oneGraphAuth)

  const supportedServicesCount = (supportedServices || []).length

  React.useEffect(() => {
    if (!corsConfigurationRequired && supportedServicesCount > 0) {
      onCorsConfiguredSuccess()
    }
  }, [corsConfigurationRequired, supportedServicesCount])

  if (!isValidUUID(oneGraphAppId)) {
    return 'Please set a valid app id in step 1 first'
  }

  if (
    missingOneGraphAppId ||
    supportedServicesCount === 0 ||
    corsConfigurationRequired
  ) {
    const origin = isSsr ? '' : window.location.origin

    return (
      <nav>
        <a
          className="App-link"
          href={`${oneGraphSiteHost}/dashboard/app/${oneGraphAppId}?add-cors-origin=${origin}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Please click here to add {origin} to your allowed CORS origins and
          then refresh
        </a>
      </nav>
    )
  } else if (!corsConfigurationRequired) {
    return (
      <>
        Great, CORS has been configured so{' '}
        <code>{inferredVercelProjectName}</code> can make all the OneGraph API
        calls it needs, and log into {supportedServicesCount} services.
      </>
    )
  }

  return <>CorsConfig required: {String(corsConfigurationRequired)}</>
}

export default function Index({}) {
  const [state, setState] = React.useState({
    vercelUser: null,
    corsConfigurationRequired: true,
    inferredVercelProjectName: null,
    oneGraphAppId: ONE_GRAPH_APP_ID,
    oneGraphSubscriptClient: null,
    errorMessage: null,
    oneGraphAuth: null,
    vercelProjectId: null,
    projectLogs: [],
  })

  React.useEffect(() => {
    if (isValidUUID(state.oneGraphAppId)) {
      const oneGraphAuth = new OneGraphAuth({
        appId: state.oneGraphAppId,
        oneGraphOrigin: 'https://serve.onegraph.io',
      })

      const oneGraphSubscriptClient = new SubscriptionClient(
        state.oneGraphAppId,
        {
          oneGraphAuth: oneGraphAuth,
          host: 'serve.onegraph.io',
        }
      )

      setState((oldState) => {
        return {
          ...oldState,
          oneGraphAuth: oneGraphAuth,
          oneGraphSubscriptClient: oneGraphSubscriptClient,
        }
      })
    }
  }, [state.oneGraphAppId])
  //https://vercel.com/import/project?template=https://github.com/sgrove/throw-away-delete-me-2
  //https://github.com/sgrove/next-js-auth-guardian-starterkit
  React.useEffect(() => {
    if (!isSsr) {
      let hostname = window.location.hostname
      hostname = 'throw-away-delete-me-2.now.sh'

      setState((oldState) => {
        return {
          ...oldState,
          inferredVercelProjectName: guessVercelProjectName(hostname),
        }
      })
    }
  }, [isSsr])

  const validOneGraphAppId = isValidUUID(state.oneGraphAppId || '')
  const steps = [
    {
      component: (
        <StepSetOneGraphAppId
          oneGraphAppId={state.oneGraphAppId}
          setOneGraphAppId={(oneGraphAppId) =>
            setState((oldState) => {
              return { ...oldState, oneGraphAppId: oneGraphAppId }
            })
          }
        />
      ),
    },
    {
      component: (
        <StepSetCorsOrigin
          oneGraphAppId={state.oneGraphAppId}
          oneGraphAuth={state.oneGraphAuth}
          onCorsConfiguredSuccess={() => {
            setState((oldState) => {
              return { ...oldState, corsConfigurationRequired: false }
            })
          }}
        />
      ),
    },
    {
      component: (
        <StepSetServerSideAuthToken
          oneGraphAppId={state.oneGraphAppId}
          oneGraphAuth={state.oneGraphAuth}
          oneGraphServerSideAccessToken={state.oneGraphServerSideAccessToken}
          setOneGraphServerSideAccessToken={(oneGraphServerSideAccessToken) =>
            setState((oldState) => {
              return {
                ...oldState,
                oneGraphServerSideAccessToken: oneGraphServerSideAccessToken,
              }
            })
          }
        />
      ),
    },
    {
      component: (
        <div style={{ display: 'flex' }}>
          <div className="card" style={{ flexGrow: '1' }}>
            <StepTriggerDeploy
              inferredVercelProjectName={state.vercelProject?.name}
              vercelProjectId={state.vercelProjectId}
              vercelUser={state.vercelUser}
              oneGraphAuth={state.oneGraphAuth}
              oneGraphSubscriptClient={state.oneGraphSubscriptClient}
              oneGraphServerSideAccessToken={
                state.oneGraphServerSideAccessToken || 'TODO'
              }
              onCommitChanges={async () => {
                let result = await fetchOneGraph(
                  state.oneGraphAuth,
                  vercelOperationDoc,
                  { projectId: state.vercelProjectId },
                  'TriggerRedeployMutation'
                )
              }}
              onLoggedIntoVercel={async () => {
                let result = await fetchOneGraph(
                  state.oneGraphAuth,
                  vercelOperationDoc,
                  {},
                  'FindMeOnVercel'
                )
                const vercelUser = result?.data?.me?.vercel

                result = await fetchOneGraph(
                  state.oneGraphAuth,
                  vercelOperationDoc,
                  { projectName: state.inferredVercelProjectName },
                  'VercelProjectByNameQuery'
                )
                const vercelProject = result?.data?.vercel?.projectByName
                const projectId = vercelProject?.id

                setState((oldState) => {
                  return {
                    ...oldState,
                    vercelUser: vercelUser,
                    vercelProject: vercelProject,
                    vercelProjectId: projectId,
                  }
                })
              }}
            />
          </div>
        </div>
      ),
    },
  ]
  return (
    <>
      <Meta />
      <div className="min-h-screen">
        <main>
          <Head>
            <title>Next.js AuthGuardian First-Setup Wizard</title>
            <link
              rel="stylesheet"
              href="https://unpkg.com/purecss@2.0.3/build/pure-min.css"
              integrity="sha384-cg6SkqEOCV1NbJoCu11+bm0NvBRc8IYLRGXkmNrqUBfTjmMYwNKPWBTIKyw9mHNJ"
              crossorigin="anonymous"
            />
          </Head>
          <Container>
            <MultiStep steps={steps} />
            {/* <br />
            <textarea
              className="jwt-preview"
              style={{ userSelect: 'all' }}
              rows={10}
              value={JSON.stringify(state, null, 2)}
              readOnly={true}
            ></textarea>{' '} */}
          </Container>
        </main>
      </div>
      <Footer />
      <style jsx global>{`
        a {
          text-decoration: underline;
          color: blue;
        }

        input {
          border: 1px solid #333;
          border-radius: 4px;
          padding: 6px;
          margin: 6px;
        }

        @keyframes flickerAnimation {
          0% {
            opacity: 1;
          }
          50% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        @-o-keyframes flickerAnimation {
          0% {
            opacity: 1;
          }
          50% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        @-moz-keyframes flickerAnimation {
          0% {
            opacity: 1;
          }
          50% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        @-webkit-keyframes flickerAnimation {
          0% {
            opacity: 1;
          }
          50% {
            opacity: 0;
          }
          100% {
            opacity: 1;
          }
        }
        .animate-flicker {
          -webkit-animation: flickerAnimation 1s infinite;
          -moz-animation: flickerAnimation 1s infinite;
          -o-animation: flickerAnimation 1s infinite;
          animation: flickerAnimation 1s infinite;
        }
        button.card {
          background-color: unset;
          cursor: pointer;
        }
        .container.mx-auto button {
          background-color: unset;
          cursor: pointer;
          margin: 1rem;
          flex-basis: 20%;
          padding: 1.5rem;
          text-align: left;
          color: inherit;
          text-decoration: none;
          border: 1px solid #eaeaea;
          border-radius: 10px;
          transition: color 0.15s ease, border-color 0.15s ease;
        }
        .container.mx-auto button:hover,
        .container.mx-auto button:focus,
        .container.mx-auto button:active {
          color: #0070f3;
          border-color: #0070f3;
        }
        textarea.card {
          width: 100%;
        }
        textarea {
          width: 100%;
        }
        .card {
          margin: 1rem;
          flex-basis: 20%;
          padding: 1.5rem;
          text-align: left;
          color: inherit;
          text-decoration: none;
          border: 1px solid #eaeaea;
          border-radius: 10px;
          transition: color 0.15s ease, border-color 0.15s ease;
        }
        .card:hover,
        .card:focus,
        .card:active {
          color: #0070f3;
          border-color: #0070f3;
        }
        .card h3 {
          margin: 0 0 1rem 0;
          font-size: 1.5rem;
        }
        .card p {
          margin: 0;
          font-size: 1.25rem;
          line-height: 1.5;
        }
      `}</style>
    </>
  )
}

export async function getStaticProps() {
  return {
    props: {},
  }
}
