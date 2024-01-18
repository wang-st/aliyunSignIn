/*
cron "0 9 * * *" autoSignin.js, tag=阿里云盘签到
*/
const axios = require('axios')
const { initInstance, getEnv, updateCkEnv } = require('./qlApi.js')
const notify = require('./sendNotify')
const updateAccessTokenURL = 'https://auth.aliyundrive.com/v2/account/token'
const rewardURL =
  'https://member.aliyundrive.com/v1/activity/sign_in_reward?_rx-s=mobile'
const rewardURLV2 =
  'https://member.aliyundrive.com/v2/activity/sign_in_task_reward?_rx-s=mobile'
const signInURLV2 =
  'https://member.aliyundrive.com/v2/activity/sign_in_list?_rx-s=mobile'
// 使用 refresh_token 更新 access_token
function updateAccessToken(queryBody, remarks) {
  const errorMessage = [remarks, '更新 access_token 失败']
  return axios(updateAccessTokenURL, {
    method: 'POST',
    data: queryBody,
    headers: { 'Content-Type': 'application/json' }
  })
    .then(d => d.data)
    .then(d => {
      const { code, message, nick_name, refresh_token, access_token } = d
      if (code) {
        if (
          code === 'RefreshTokenExpired' ||
          code === 'InvalidParameter.RefreshToken'
        )
          errorMessage.push('refresh_token 已过期或无效')
        else errorMessage.push(message)
        return Promise.reject(errorMessage.join(', '))
      }
      return { nick_name, refresh_token, access_token }
    })
    .catch(e => {
      errorMessage.push(e.message)
      return Promise.reject(errorMessage.join(', '))
    })
}

function sign_inv2(access_token, remarks) {
  const sendMessage = [remarks]
  return axios(signInURLV2, {
    method: 'POST',
    data: {
      isReward: false
    },
    headers: {
      Authorization: access_token,
      'Content-Type': 'application/json'
    }
  })
    .then(d => d.data)
    .then(async json => {
      if (!json.success) {
        sendMessage.push('签到失败', json.message)
        return Promise.reject(sendMessage.join(', '))
      }
      sendMessage.push('签到成功')
      const { signInInfos, signInCount } = json.result
      const currentSignInfo = signInInfos[signInCount - 1] // 当天签到信息
      const signInDay = currentSignInfo.day
      sendMessage.push(`本月累计签到 ${signInCount} 天`)
      for await (reward of currentSignInfo.rewards) {
        if (reward.status == 'finished') {
          if (reward.type == 'dailySignIn') {
            try {
              const rewardInfo = await getReward(access_token, signInDay)
              sendMessage.push(
                `第${signInDay}天奖励领取成功: 获得${rewardInfo.name || ''}${
                  rewardInfo.description || ''
                }`
              )
            } catch (e) {
              sendMessage.push(`第${signInDay}天奖励领取失败:`, e)
            }
          } else if (reward.type == 'dailyTask') {
            try {
              const rewardInfo = await getRewardV2(access_token, signInDay)
              sendMessage.push(
                `第${signInDay}天奖励领取成功: 获得${rewardInfo.name || ''}${
                  rewardInfo.notice || ''
                }`
              )
            } catch (e) {
              sendMessage.push(
                `第${signInDay}天奖励领取失败:${reward.name || ''}`,
                e
              )
            }
          }
        } else if (reward.status == 'unfinished') {
          sendMessage.push(
            `第${signInDay}天未领取奖励: ${reward.name || ''} 任务未完成 ${
              reward.remind
            }`
          )
        } else if (reward.status == 'end') {
          sendMessage.push(
            `第${signInDay}天未领取奖励: ${reward.name || ''} 任务已结束 ${
              reward.remind
            }`
          )
        } else {
          sendMessage.push(`第${signInDay}天领取奖励:${reward.name || ''}`)
        }
      }
      return sendMessage.join('\n')
    })
    .catch(e => {
      sendMessage.push('签到失败')
      sendMessage.push(e.message)
      return Promise.reject(sendMessage.join(', '))
    })
}

// 领取奖励
function getRewardV2(access_token, signInDay) {
  return axios(rewardURLV2, {
    method: 'POST',
    data: { signInDay },
    headers: {
      authorization: access_token,
      'Content-Type': 'application/json'
    }
  })
    .then(d => d.data)
    .then(json => {
      if (!json.success) {
        return Promise.reject(json.message)
      }

      return json.result
    })
}
function getReward(access_token, signInDay) {
  return axios(rewardURL, {
    method: 'POST',
    data: { signInDay },
    headers: {
      authorization: access_token,
      'Content-Type': 'application/json'
    }
  })
    .then(d => d.data)
    .then(json => {
      if (!json.success) {
        return Promise.reject(json.message)
      }

      return json.result
    })
}

// 获取环境变量
async function getRefreshToken() {
  let instance = null
  try {
    instance = await initInstance()
  } catch (e) {}

  let refreshToken = process.env.refreshToken || []
  try {
    if (instance) refreshToken = await getEnv(instance, 'refreshToken')
  } catch (e) {}

  let refreshTokenArray = []

  if (Array.isArray(refreshToken)) refreshTokenArray = refreshToken
  else if (refreshToken.indexOf('&') > -1)
    refreshTokenArray = refreshToken.split('&')
  else if (refreshToken.indexOf('\n') > -1)
    refreshTokenArray = refreshToken.split('\n')
  else refreshTokenArray = [refreshToken]

  if (!refreshTokenArray.length) {
    console.log('未获取到refreshToken, 程序终止')
    process.exit(1)
  }

  return {
    instance,
    refreshTokenArray
  }
}

!(async () => {
  const { instance, refreshTokenArray } = await getRefreshToken()
  const message = []
  let index = 1
  for await (refreshToken of refreshTokenArray) {
    let remarks = refreshToken.remarks || `账号${index}`
    const queryBody = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken.value || refreshToken
    }

    try {
      const { nick_name, refresh_token, access_token } =
        await updateAccessToken(queryBody, remarks)

      if (nick_name && nick_name !== remarks)
        remarks = `${nick_name}(${remarks})`

      // 更新环境变量
      if (instance) {
        let params = {
          name: refreshToken.name,
          value: refresh_token,
          remarks: refreshToken.remarks || nick_name // 优先存储原有备注信息
        }
        // 新版青龙api
        if (refreshToken.id) {
          params.id = refreshToken.id
        }
        // 旧版青龙api
        if (refreshToken._id) {
          params._id = refreshToken._id
        }
        await updateCkEnv(instance, params)
      }

      const sendMessage = await sign_inv2(access_token, remarks)
      console.log('\n')
      message.push(sendMessage)
      message.push('\n')
    } catch (e) {
      console.log(e)
      console.log('\n')
      message.push(e)
    }
    index++
  }
  console.log(message.join('\n'))
  await notify.sendNotify(`阿里云盘签到`, message.join('\n'))
})()
