import {
  ActiveDing,
  CameraData,
  CameraHealth,
  HistoricalDingGlobal,
  RingCameraModel,
  SnapshotTimestamp
} from './ring-types'
import { clientApi, RingRestClient } from './rest-client'
import { BehaviorSubject, Subject } from 'rxjs'
import {
  distinctUntilChanged,
  filter,
  map,
  publishReplay,
  refCount,
  share,
  take
} from 'rxjs/operators'
import { delay, logError } from './util'

const snapshotTimestampGracePeriod = 10000

function getBatteryLevel(data: CameraData) {
  const batteryLevel =
    typeof data.battery_life === 'number'
      ? data.battery_life
      : Number.parseFloat(data.battery_life)

  if (isNaN(batteryLevel)) {
    return null
  }

  return batteryLevel
}

export class RingCamera {
  id = this.initialData.id
  deviceType = this.initialData.kind
  model = RingCameraModel[this.initialData.kind] || 'Unknown Model'
  hasLight = this.initialData.led_status !== undefined
  hasSiren = this.initialData.siren_status !== undefined

  onData = new BehaviorSubject<CameraData>(this.initialData)
  onRequestUpdate = new Subject()

  onNewDing = new Subject<ActiveDing>()
  onActiveDings = new BehaviorSubject<ActiveDing[]>([])
  onDoorbellPressed = this.onNewDing.pipe(
    filter(ding => ding.kind === 'ding'),
    share()
  )
  onMotionDetected = this.onActiveDings.pipe(
    map(dings => dings.some(ding => ding.motion || ding.kind === 'motion')),
    distinctUntilChanged(),
    publishReplay(1),
    refCount()
  )
  onBatteryLevel = this.onData.pipe(
    map(getBatteryLevel),
    distinctUntilChanged()
  )

  constructor(
    private initialData: CameraData,
    public isDoorbot: boolean,
    private restClient: RingRestClient
  ) {}

  updateData(update: CameraData) {
    this.onData.next(update)
  }

  requestUpdate() {
    this.onRequestUpdate.next()
  }

  get data() {
    return this.onData.getValue()
  }

  get name() {
    return this.data.description
  }

  get activeDings() {
    return this.onActiveDings.getValue()
  }

  get batteryLevel() {
    return getBatteryLevel(this.data)
  }

  doorbotUrl(path: string) {
    return clientApi(`doorbots/${this.id}/${path}`)
  }

  async setLight(on: boolean) {
    if (!this.hasLight) {
      return false
    }

    const state = on ? 'on' : 'off'

    await this.restClient.request({
      method: 'PUT',
      url: this.doorbotUrl('floodlight_light_' + state)
    })

    this.updateData({ ...this.data, led_status: state })

    return true
  }

  async setSiren(on: boolean) {
    if (!this.hasSiren) {
      return false
    }

    const state = on ? 'on' : 'off'

    await this.restClient.request({
      method: 'PUT',
      url: this.doorbotUrl('siren_' + state)
    })

    this.updateData({ ...this.data, siren_status: { seconds_remaining: 1 } })

    return true
  }

  async getHealth() {
    const response = await this.restClient.request<{
      device_health: CameraHealth
    }>({
      url: this.doorbotUrl('health')
    })

    return response.device_health
  }

  startVideoOnDemand() {
    return this.restClient.request({
      method: 'POST',
      url: this.doorbotUrl('vod')
    })
  }

  async getSipConnectionDetails() {
    const vodPromise = this.onNewDing
      .pipe(
        filter(x => x.kind === 'on_demand'),
        take(1)
      )
      .toPromise()
    await this.startVideoOnDemand()
    return vodPromise
  }

  processActiveDing(ding: ActiveDing) {
    const activeDings = this.activeDings

    this.onNewDing.next(ding)
    this.onActiveDings.next(activeDings.concat([ding]))

    setTimeout(() => {
      const allActiveDings = this.activeDings,
        otherDings = allActiveDings.filter(oldDing => oldDing !== ding)
      this.onActiveDings.next(otherDings)
    }, 65 * 1000) // dings last ~1 minute
  }

  getHistory(limit = 10, favoritesOnly = false) {
    const favoritesParam = favoritesOnly ? '&favorites=1' : ''
    return this.restClient.request<HistoricalDingGlobal[]>({
      url: this.doorbotUrl(`history?limit=${limit}${favoritesParam}`)
    })
  }

  async getRecording(dingIdStr: string) {
    const response = await this.restClient.request<{ url: string }>({
      url: clientApi(`dings/${dingIdStr}/share/play?disable_redirect=true`)
    })
    return response.url
  }

  private async updateTimestamp() {
    const { timestamps, responseTimestamp } = await this.restClient.request<{
        timestamps: SnapshotTimestamp[]
      }>({
        url: clientApi(`snapshots/timestamps`),
        method: 'POST',
        data: {
          doorbot_ids: [this.id]
        },
        json: true
      }),
      timestamp = timestamps[0]

    return {
      timestamp: timestamp ? timestamp.timestamp : 0,
      responseTimestamp
    }
  }

  private refreshSnapshotInProgress?: Promise<void>
  hasSlowSnapshotRefresh = this.deviceType === 'doorbell_v3' // only refreshes timestamp every 10 minutes

  private async refreshSnapshot(allowStale: boolean) {
    const slowSnapshots = this.hasSlowSnapshotRefresh && !allowStale,
      snapshotRefreshDelay = slowSnapshots ? 2000 : 500,
      maxSnapshotRefreshSeconds = slowSnapshots
        ? 600 // 10 minutes if waiting for slow snapshots
        : this.hasSlowSnapshotRefresh
        ? 5 // fail quickly for slow snapshot devices when stale images are ok
        : 30, // wait 30 seconds for normal devices
      maxSnapshotRefreshAttempts =
        (maxSnapshotRefreshSeconds * 1000) / snapshotRefreshDelay

    for (let i = 0; i < maxSnapshotRefreshAttempts; i++) {
      const { timestamp, responseTimestamp } = await this.updateTimestamp(),
        timestampAge = Math.abs(responseTimestamp - timestamp)

      if (timestampAge < snapshotTimestampGracePeriod) {
        return
      }

      await delay(snapshotRefreshDelay)
    }

    throw new Error(
      `Snapshot failed to refresh after ${maxSnapshotRefreshAttempts} attempts`
    )
  }

  async getSnapshot(allowStale = false) {
    this.refreshSnapshotInProgress =
      this.refreshSnapshotInProgress || this.refreshSnapshot(allowStale)

    try {
      await this.refreshSnapshotInProgress
    } catch (e) {
      logError(e)
    }

    this.refreshSnapshotInProgress = undefined

    return this.restClient.request<Buffer>({
      url: clientApi(`snapshots/image/${this.id}`),
      responseType: 'arraybuffer'
    })
  }
}
