import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result } from 'antd'
import i18n from '@/i18n'

interface Props {
  children: ReactNode
  /** 面板名，用于错误提示定位 */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * feature 面板级错误边界：单面板崩溃只黑一张卡片，不白屏整窗。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info)
  }

  render(): ReactNode {
    if (this.state.error) {
      // 类组件里没有 hooks，直接用 i18next 实例取文案
      return (
        <Result
          status="error"
          title={i18n.t('common.panelCrashed')}
          subTitle={this.state.error.message}
          extra={
            <Button size="small" onClick={() => this.setState({ error: null })}>
              {i18n.t('common.reload')}
            </Button>
          }
        />
      )
    }
    return this.props.children
  }
}
