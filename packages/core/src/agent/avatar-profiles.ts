import type { AvatarPresentationProfile } from './avatar-types.js'

export const retailProfessionalAvatarProfile: AvatarPresentationProfile = {
  name: 'retail-professional',
  motionStyle: 'subtle',
  defaultExpression: 'professional',
  stateExpressionMap: {
    idle: 'professional',
    listening: 'focused',
    thinking: 'focused',
    speaking: 'reassuring',
    waiting: 'attentive',
    confirming: 'serious',
  },
  intentExpressionMap: {
    complaint: 'reassuring',
    manager_approval: 'serious',
    order_confirmed: 'approving',
    payment_issue: 'serious',
    product_search: 'focused',
    staff_handoff: 'professional',
  },
  eventGestureMap: {
    speakerDetected: 'professional_greeting',
    targetChanged: 'small_nod',
    queueWaiting: 'acknowledge_queue',
    taskAvailable: 'small_nod',
    responseStart: 'open_palm',
    responseEnd: 'small_nod',
    draftCreated: 'present_options',
    approvalApproved: 'confirm_action',
    approvalRejected: 'polite_apology',
    actionCompleted: 'thank_you',
    actionFailed: 'polite_apology',
  },
}
